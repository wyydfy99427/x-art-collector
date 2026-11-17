'use strict';
importScripts('core.js');
const C = XArtCore;
const MAX_DOWNLOADS = 3;
let state;
let loading;
let stateWrites = Promise.resolve();
let scanLock = false;
let pumpLock = false;
let finishLock = false;
let finishAgain = false;
let offscreenCreation;
const preparing = new Set();

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('x-art-collector', 2);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('images')) {
      const images = request.result.createObjectStore('images', { keyPath: 'key' });
      images.createIndex('status', 'status');
      images.createIndex('downloadId', 'downloadId');
      images.createIndex('jobs', 'jobs', { multiEntry: true });
    }
    if (!request.result.objectStoreNames.contains('taskArchive')) request.result.createObjectStore('taskArchive', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function records(mode, operation, name = 'images') {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('数据库写入取消'));
  });
}
const getImage = key => records('readonly', store => store.get(key));
const byStatus = status => records('readonly', store => store.index('status').getAll(status));
const byJob = id => records('readonly', store => store.index('jobs').getAll(id));
const putImage = value => records('readwrite', store => store.put(value));
async function editImage(key, change) {
  return records('readwrite', store => {
    const request = store.get(key);
    request.onsuccess = () => { if (request.result) { change(request.result); store.put(request.result); } };
  });
}
async function init() {
  if (!loading) loading = (async () => {
    const saved = await chrome.storage.local.get('state');
    state = saved.state || { version: 1, watches: {}, jobs: [], lastAutoDay: null };
    for (const item of await byStatus('preparing')) {
      item.status = 'pending'; await putImage(item);
    }
    for (const item of await byStatus('downloading')) await reconcileDownload(item);
    await badge();
    return state;
  })();
  return loading;
}
async function save() {
  const snapshot = JSON.parse(JSON.stringify(state));
  stateWrites = stateWrites.catch(() => {}).then(() => chrome.storage.local.set({ state: snapshot }));
  await stateWrites;
}
function isFailure(job) { return ['failed', 'partial'].includes(job.status); }
async function badge() {
  if (!state) return;
  const failed = state.jobs.some(j => !j.hidden && isFailure(j));
  const busy = state.jobs.some(j => ['queued', 'scanning', 'downloading'].includes(j.status));
  await chrome.action.setBadgeBackgroundColor({ color: failed ? '#c73535' : '#167d67' });
  await chrome.action.setBadgeText({ text: failed ? '!' : busy ? '…' : '' });
}
async function ensureAlarm() {
  if (state.jobs.some(j => ['queued', 'scanning', 'downloading'].includes(j.status))) {
    if (!await chrome.alarms.get('recoverWork')) await chrome.alarms.create('recoverWork', { periodInMinutes: 1 });
  } else await chrome.alarms.clear('recoverWork');
}
async function offscreen(message) {
  if (offscreenCreation) await offscreenCreation;
  if (!await chrome.offscreen.hasDocument()) {
    if (!offscreenCreation) offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'], justification: '验证原图尺寸并创建下载用 Blob，避免缩略图或错误页面被保存。'
    }).finally(() => { offscreenCreation = null; });
    await offscreenCreation;
  }
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}
async function release(key) {
  if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'release', token: key }).catch(() => {});
}
function enqueueJob(name, kind, since, until, force = false) {
  const artist = C.handle(name);
  if (!artist) throw new Error('请输入有效的画师账号');
  if (kind === 'update' && !state.watches[artist]) throw new Error('该画师尚未开启追踪');
  if (state.jobs.some(j => j.handle === artist && ['queued', 'scanning', 'downloading'].includes(j.status))) throw new Error('该画师已有任务，请等待完成或先停止');
  const now = Date.now();
  const job = {
    id: crypto.randomUUID(), handle: artist, kind, since: since || 0, force: Boolean(force),
    until: until || now, cutoff: now, status: 'queued', scanDone: false,
    created: now, updated: now, seen: 0, oldest: null, error: '', note: '', tabId: null
  };
  state.jobs.push(job);
  // Retain all actionable tasks; keep recent successful/cancelled summaries.
  const settled = state.jobs.filter(j => ['complete', 'cancelled'].includes(j.status));
  if (settled.length > 80) {
    const remove = new Set(settled.slice(0, settled.length - 80).map(j => j.id));
    state.jobs = state.jobs.filter(j => !remove.has(j.id));
  }
  return job;
}
async function queueJob(name, kind, since, until, force = false) {
  const job = enqueueJob(name, kind, since, until, force);
  await save(); await ensureAlarm(); await badge();
  void kick();
  return job;
}
async function beginTab(job) {
  if (job.tabId == null) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (tab.status !== 'complete') return;
    if (!/^https:\/\/(x|twitter)\.com\//.test(tab.url || '')) throw new Error('扫描页面未能打开 X');
    const result = await chrome.tabs.sendMessage(job.tabId, { type: 'beginScan', job: { id: job.id, handle: job.handle, kind: job.kind, since: job.since, until: job.until } });
    if (!result?.ok) throw new Error('扫描器没有响应');
  } catch (error) {
    if (Date.now() - job.updated > 90000) await endScan(job, { error: '扫描页无法连接，请确认 X 已登录后重试' });
  }
}
async function nextScan() {
  if (scanLock) return;
  scanLock = true;
  try {
    let job = state.jobs.find(j => j.status === 'scanning');
    if (job) { await beginTab(job); return; }
    job = state.jobs.find(j => j.status === 'queued');
    if (!job) return;
    job.status = 'scanning'; job.updated = Date.now();
    await save(); await badge();
    try {
      const tab = await chrome.tabs.create({ url: C.photoPageUrl(job.handle), active: false });
      // A cancellation can arrive while Chrome creates the tab.
      if (job.status !== 'scanning') { await chrome.tabs.remove(tab.id); return; }
      job.tabId = tab.id; await save(); await beginTab(job);
    } catch (error) { await endScan(job, { error: `无法创建扫描页：${error.message}` }); }
  } finally { scanLock = false; }
}
async function endScan(job, result) {
  if (job.status !== 'scanning') return;
  job.scanDone = true; job.updated = Date.now();
  job.error = result.error || '';
  job.boundary = Boolean(result.boundary);
  job.note = result.reason || '';
  if (result.diagnostics) job.diagnostics = result.diagnostics;
  job.status = 'downloading';
  const tabId = job.tabId; job.tabId = null;
  await save();
  if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
  await finishJobs();
  void kick();
}
async function addBatch(job, tweets) {
  const candidates = [];
  for (const raw of tweets.slice(0, 1000)) {
    // Scanner sends the normalized timestamp as a number.
    const tweet = C.normalizeTweet({ ...raw, createdAt: new Date(raw.created).toISOString() });
    if (!tweet || !C.eligible(tweet, job)) continue;
    for (const photo of tweet.photos) candidates.push({
      key: C.imageKey(tweet.id, photo.index), handle: job.handle, tweetId: tweet.id,
      created: tweet.created, index: photo.index, url: photo.url,
      width: photo.width, height: photo.height, jobs: [job.id], status: 'pending', attempts: 0
    });
  }
  await records('readwrite', store => {
    for (const item of candidates) {
      const get = store.get(item.key);
      get.onsuccess = () => {
        if (!get.result) store.put(item);
        else {
          const previous = get.result;
          const newJob = !previous.jobs.includes(job.id);
          if (!previous.jobs.includes(job.id)) previous.jobs.push(job.id);
          if (job.force && newJob && previous.status === 'complete') {
            previous.status = 'pending'; delete previous.downloadId;
          }
          // Failed records require an explicit retry; cancelled records may resume in a new task.
          if (previous.status === 'cancelled') previous.status = 'pending';
          store.put(previous);
        }
      };
    }
  });
}
async function prepareDownload(item) {
  const key = item.key;
  try {
    const response = await offscreen({ type: 'prepare', token: key, url: item.url, width: item.width, height: item.height });
    const current = await getImage(key);
    if (current?.status !== 'preparing') { await release(key); return; }
    if (!response?.ok) throw new Error(response?.error || '原图验证失败');
    const downloadId = await chrome.downloads.download({
      url: response.url, filename: C.filename(item, response.ext), saveAs: false, conflictAction: 'uniquify'
    });
    await editImage(key, record => {
      if (record.status !== 'preparing') return;
      record.status = 'downloading'; record.downloadId = downloadId;
      record.actualWidth = response.width; record.actualHeight = response.height;
      record.bytes = response.bytes; record.error = ''; record.started = Date.now();
    });
    if ((await getImage(key))?.status !== 'downloading') {
      await chrome.downloads.cancel(downloadId).catch(() => {});
      await release(key); return;
    }
    // Chrome can finish a small file before its ID was committed.
    await reconcileDownload(await getImage(key));
  } catch (error) {
    await editImage(key, record => {
      if (record.status === 'preparing') { record.status = 'failed'; record.error = error.message; }
    });
    await release(key);
  } finally {
    preparing.delete(key);
    await finishJobs();
    void pumpDownloads();
  }
}
async function pumpDownloads() {
  if (pumpLock) return;
  pumpLock = true;
  try {
    const downloads = await byStatus('downloading');
    // A newly started Chrome download remains in `preparing` until reconciliation finishes.
    const occupied = new Set([...downloads.map(i => i.key), ...preparing]);
    const capacity = MAX_DOWNLOADS - occupied.size;
    if (capacity <= 0) return;
    const pending = await byStatus('pending');
    const jobs = new Set(state.jobs.filter(j => ['scanning', 'downloading', 'queued'].includes(j.status)).map(j => j.id));
    for (const item of pending.filter(item => item.jobs.some(id => jobs.has(id))).slice(0, capacity)) {
      if (preparing.has(item.key)) continue;
      preparing.add(item.key);
      item.status = 'preparing'; item.attempts++; item.started = Date.now();
      await putImage(item);
      void prepareDownload(item);
    }
  } finally { pumpLock = false; }
}
async function reconcileDownload(item) {
  if (!item || item.status !== 'downloading') return;
  const [download] = await chrome.downloads.search({ id: item.downloadId });
  if (download?.state === 'in_progress') return;
  await editImage(item.key, record => {
    if (record.status !== 'downloading') return;
    record.status = download?.state === 'complete' ? 'complete' : 'failed';
    record.error = record.status === 'failed' ? `下载未完成：${download?.error || 'Chrome 中没有该下载记录'}` : '';
    if (record.status === 'complete') { record.completed = Date.now(); record.filename = download.filename; }
  });
  await release(item.key);
}
async function finishJobs() {
  if (finishLock) { finishAgain = true; return; }
  finishLock = true;
  try {
  let changed = false;
  for (const job of state.jobs.filter(j => j.status === 'downloading' && j.scanDone)) {
    const images = await byJob(job.id);
    if (job.status !== 'downloading') continue;
    if (images.some(i => ['pending', 'preparing', 'downloading'].includes(i.status))) continue;
    const failed = images.filter(i => i.status === 'failed').length;
    job.status = job.error ? 'failed' : failed ? 'partial' : 'complete';
    job.updated = Date.now();
    if (job.hidden) await records('readwrite', store => store.put({ ...job }), 'taskArchive');
    if (job.status === 'complete' && job.kind === 'update' && state.watches[job.handle]) {
      state.watches[job.handle].lastSuccess = job.cutoff;
    }
    changed = true;
  }
  if (changed) await save();
  await badge(); await ensureAlarm();
  } finally {
    finishLock = false;
    if (finishAgain) { finishAgain = false; void finishJobs(); }
  }
}
async function retryJob(job) {
  if (!job || !isFailure(job)) throw new Error('该任务没有待重试的失败记录');
  if (state.jobs.some(j => j.id !== job.id && j.handle === job.handle && ['queued', 'scanning', 'downloading'].includes(j.status))) throw new Error('该画师有正在运行的任务');
  for (const image of await byJob(job.id)) {
    if (image.status === 'failed') await editImage(image.key, record => { record.status = 'pending'; record.error = ''; delete record.downloadId; });
  }
  job.hidden = false;
  await records('readwrite', store => store.delete(job.id), 'taskArchive');
  if (job.error) { job.status = 'queued'; job.scanDone = false; job.seen = 0; }
  else job.status = 'downloading';
  job.error = ''; job.updated = Date.now();
  await save(); await badge(); await ensureAlarm(); void kick();
}
async function cancelJob(job) {
  if (!job || ['complete', 'cancelled'].includes(job.status)) return;
  job.status = 'cancelled'; job.updated = Date.now();
  if (job.hidden) await records('readwrite', store => store.put({ ...job, tabId: null }), 'taskArchive');
  const tabId = job.tabId; job.tabId = null;
  await save();
  if (tabId != null) {
    await chrome.tabs.sendMessage(tabId, { type: 'stopScan' }).catch(() => {});
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  const activeJobs = new Set(state.jobs.filter(j => ['queued', 'scanning', 'downloading'].includes(j.status)).map(j => j.id));
  for (const image of await byJob(job.id)) {
    if (image.jobs.some(id => activeJobs.has(id)) || ['complete', 'failed'].includes(image.status)) continue;
    await editImage(image.key, record => { record.status = 'cancelled'; });
    if (image.downloadId != null) await chrome.downloads.cancel(image.downloadId).catch(() => {});
    if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'abort', token: image.key }).catch(() => {});
    await release(image.key);
  }
  await badge(); await ensureAlarm(); void kick();
}
async function dailyStartup() {
  await init();
  // Persisted tab IDs belong to the previous browser session. Queue an interrupted
  // scan again instead of attaching to (or closing) an unrelated restored tab.
  for (const job of state.jobs.filter(j => j.status === 'scanning')) {
    job.status = 'queued'; job.tabId = null;
  }
  const today = C.localDay();
  if (state.lastAutoDay !== today) {
    for (const watch of Object.values(state.watches)) {
    // An unresolved failure requires the user's explicit retry; don't silently retry next startup.
    if (state.jobs.some(j => j.handle === watch.handle && (isFailure(j) || ['queued', 'scanning', 'downloading'].includes(j.status)))) continue;
      enqueueJob(watch.handle, 'update', watch.lastSuccess || watch.since, 0);
    }
    state.lastAutoDay = today;
  }
  // Commit the full daily queue with its day marker in one storage write. If the
  // worker stops halfway through saving hundreds of watches, none are skipped.
  await save(); await ensureAlarm(); await badge();
  void kick();
}
async function kick() {
  await init();
  await nextScan();
  await pumpDownloads();
  await finishJobs();
}
async function clearVisibleRecords() {
  const visible = state.jobs.filter(j => !j.hidden);
  for (const job of visible) job.hidden = true;
  await records('readwrite', store => { for (const job of visible) store.put({ ...job }); }, 'taskArchive');
  await save(); await badge();
  return { ok: true, cleared: visible.length };
}
async function summary(includeHidden = false) {
  const jobs = [];
  const archive = includeHidden ? await records('readonly', store => store.getAll(), 'taskArchive') : [];
  const merged = new Map(archive.map(j => [j.id, j]));
  for (const job of state.jobs) if (includeHidden || !job.hidden) merged.set(job.id, job);
  for (const job of [...merged.values()].sort((a, b) => b.created - a.created).slice(0, 40)) {
    const images = await byJob(job.id);
    const counts = { total: images.length, complete: 0, failed: 0, pending: 0 };
    for (const item of images) {
      if (item.status === 'complete') counts.complete++;
      if (item.status === 'failed') counts.failed++;
      if (['pending', 'preparing', 'downloading'].includes(item.status)) counts.pending++;
    }
    jobs.push({ ...job, counts, failures: images.filter(i => i.status === 'failed').slice(0, 20).map(i => ({ key: i.key, error: i.error, source: `https://x.com/${i.handle}/status/${i.tweetId}` })) });
  }
  return { ok: true, maxWatches: C.MAX_WATCHES, watches: Object.values(state.watches), jobs, lastAutoDay: state.lastAutoDay, includeHidden };
}
async function exportBackup() {
  const images = await records('readonly', store => store.getAll());
  return { ok: true, data: {
    format: 'x-art-backup', version: 1, exportedAt: new Date().toISOString(),
    watches: Object.values(state.watches),
    completed: images.filter(i => i.status === 'complete').map(i => ({
      key: i.key, handle: i.handle, tweetId: i.tweetId, index: i.index, created: i.created,
      url: i.url, width: i.width, height: i.height, actualWidth: i.actualWidth, actualHeight: i.actualHeight,
      bytes: i.bytes, completed: i.completed
    }))
  } };
}
async function importBackup(data) {
  const backup = C.validateBackup(data);
  const combined = new Set([...Object.keys(state.watches), ...backup.watches.map(w => w.handle)]);
  if (combined.size > C.MAX_WATCHES) throw new Error(`合并后超过 ${C.MAX_WATCHES} 位画师，请先减少追踪名单`);
  await records('readwrite', store => {
    for (const item of backup.completed) {
      const request = store.get(item.key);
      request.onsuccess = () => {
        if (!request.result) store.put({ ...item, jobs: [], status: 'complete', attempts: 0 });
      };
    }
  });
  for (const watch of backup.watches) {
    const existing = state.watches[watch.handle];
    if (!existing) state.watches[watch.handle] = watch;
    else {
      existing.since = Math.min(existing.since, watch.since);
      // Keep the earlier cursor when merging so import cannot skip unchecked posts.
      existing.lastSuccess = Math.min(existing.lastSuccess || existing.since, watch.lastSuccess || watch.since);
    }
  }
  await save();
  return { ok: true, watches: backup.watches.length, completed: backup.completed.length };
}
async function handleMessage(message, sender) {
  if (message.type === 'offscreenHeartbeat' && sender.url === chrome.runtime.getURL('offscreen.html')) return { ok: true };
  await init();
  if (message.type === 'scanBatch' || message.type === 'scanEnd') {
    const job = state.jobs.find(j => j.id === message.jobId && j.status === 'scanning' && j.tabId === sender.tab?.id);
    if (!job) throw new Error('扫描任务已停止');
    if (message.type === 'scanEnd') await endScan(job, message);
    else {
      await addBatch(job, Array.isArray(message.tweets) ? message.tweets : []);
      job.seen = Math.max(job.seen || 0, Number(message.seen) || 0);
      if (message.diagnostics) job.diagnostics = message.diagnostics;
      if (Number.isFinite(message.oldest)) job.oldest = job.oldest == null ? message.oldest : Math.min(job.oldest, message.oldest);
      job.updated = Date.now(); await save(); void pumpDownloads();
    }
    return { ok: true };
  }
  if (message.type === 'watchStatus') return { ok: true, tracked: Boolean(state.watches[C.handle(message.handle)]) };
  if (message.type === 'toggleWatch') {
    const name = C.handle(message.handle);
    if (!name) throw new Error('画师账号无效');
    if (message.enabled && !state.watches[name]) {
      if (Object.keys(state.watches).length >= C.MAX_WATCHES) throw new Error(`最多追踪 ${C.MAX_WATCHES} 位画师`);
      state.watches[name] = { handle: name, since: Date.now(), lastSuccess: null };
    } else if (!message.enabled) {
      delete state.watches[name];
      for (const job of state.jobs.filter(j => j.handle === name && j.kind === 'update' && !['complete', 'cancelled'].includes(j.status))) await cancelJob(job);
    }
    await save(); return { ok: true };
  }
  if (message.type === 'startHistory') {
    const since = Number(message.since) || 0, until = Number(message.until) || 0;
    if (since < 0 || until < 0 || (until && since >= until) || !Number.isFinite(since + until)) throw new Error('日期范围无效');
    const job = await queueJob(message.handle, 'history', since, until, message.force); return { ok: true, jobId: job.id };
  }
  // Task controls are available only to extension pages, not X page content.
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('请通过扩展弹窗执行此操作');
  if (message.type === 'getState') return summary(Boolean(message.includeHidden));
  if (message.type === 'clearVisibleRecords') return clearVisibleRecords();
  if (message.type === 'exportBackup') return exportBackup();
  if (message.type === 'importBackup') return importBackup(message.data);
  if (message.type === 'retryJob') { await retryJob(state.jobs.find(j => j.id === message.id)); return { ok: true }; }
  if (message.type === 'cancelJob') { await cancelJob(state.jobs.find(j => j.id === message.id)); return { ok: true }; }
  if (message.type === 'checkNow') {
    const watch = state.watches[C.handle(message.handle)];
    if (!watch) throw new Error('该画师尚未追踪');
    const existing = state.jobs.find(j => j.handle === watch.handle && isFailure(j));
    if (existing) await retryJob(existing);
    else await queueJob(watch.handle, 'update', watch.lastSuccess || watch.since, 0);
    return { ok: true };
  }
  if (message.type === 'showDownloads') { chrome.tabs.create({ url: 'chrome://downloads/' }); return { ok: true }; }
  if (message.type === 'exportLog') {
    const data = await summary(true);
    return { ok: true, data: { exportedAt: new Date().toISOString(), ...data } };
  }
  throw new Error('不支持的操作');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === 'offscreen') return;
  handleMessage(message, sender).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onStartup.addListener(() => { void dailyStartup(); });
chrome.runtime.onInstalled.addListener(() => { void kick(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'complete') void init().then(() => {
    const job = state.jobs.find(j => j.tabId === id && j.status === 'scanning');
    if (job) return beginTab(job);
  });
});
chrome.tabs.onRemoved.addListener(id => {
  void init().then(() => {
    const job = state.jobs.find(j => j.tabId === id && j.status === 'scanning');
    if (job) return endScan(job, { error: '扫描标签页已关闭；已保存的图片保留，可手动重试' });
  });
});
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  void init().then(async () => {
    const items = await records('readonly', store => store.index('downloadId').getAll(delta.id));
    for (const item of items) await reconcileDownload(item);
    await finishJobs(); await pumpDownloads();
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'recoverWork') return;
  void init().then(async () => {
    for (const item of await byStatus('downloading')) await reconcileDownload(item);
    const job = state.jobs.find(j => j.status === 'scanning');
    if (job && Date.now() - job.updated > 180000) await endScan(job, { error: '扫描器超过三分钟没有响应，请手动重试' });
    await kick();
  });
});
