(() => {
  'use strict';
  const C = globalThis.XArtCore;
  const cache = new Map();
  let running = null;
  let toolbar = null;
  let toolbarHandle = null;
  let bridgeReady = false;
  let responses = [];
  let rejected = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = message => chrome.runtime.sendMessage(message).catch(() => null);
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'x-art-observed-v1') return;
    bridgeReady = Boolean(event.data.ready);
    if (Array.isArray(event.data.responses)) responses = event.data.responses.slice(-12).map(r => ({
      endpoint: String(r.endpoint || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100),
      status: Number(r.status) || 0, tweets: Number(r.tweets) || 0, photos: Number(r.photos) || 0,
      error: String(r.error || '').slice(0, 100)
    }));
    if (!Array.isArray(event.data.tweets)) return;
    for (const raw of event.data.tweets.slice(0, 1000)) {
      const tweet = C.normalizeTweet(raw);
      if (tweet) cache.set(tweet.id, tweet);
      else rejected++;
    }
    while (cache.size > 12000) cache.delete(cache.keys().next().value);
  });
  function diagnostics() {
    const url = new URL(location.href);
    return {
      page: `${url.origin}${url.pathname}${url.searchParams.get('filter') ? `?filter=${encodeURIComponent(url.searchParams.get('filter'))}` : ''}`,
      photoFilter: url.pathname.endsWith('/media') && url.searchParams.get('filter') === 'photo',
      selectedTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(tab => tab.textContent.trim().slice(0, 50)).slice(0, 6),
      bridgeReady, responses, accepted: cache.size, rejected
    };
  }
  async function scan(job) {
    if (running) return;
    // X now defaults /media to videos. Never scan that default, including a
    // restored pre-update tab or a page that dropped the query during routing.
    const url = new URL(location.href);
    if (C.profileFromUrl(url.href) === job.handle && (url.pathname !== `/${job.handle}/media` || url.searchParams.get('filter') !== 'photo')) {
      location.replace(C.photoPageUrl(job.handle));
      return;
    }
    running = { id: job.id, stop: false };
    const state = running;
    const sent = new Set();
    const older = new Set();
    let stagnant = 0;
    let previousHeight = 0;
    let ownCount = 0;
    let oldest = null;
    try {
      window.postMessage({ channel: 'x-art-request-replay-v1' }, location.origin);
      for (let round = 0; round < 5000 && !state.stop; round++) {
        if (location.pathname.startsWith('/i/flow/login') || location.pathname === '/login') throw new Error('X 尚未登录，请登录后手动重试');
        if (C.profileFromUrl(location.href) !== job.handle) throw new Error('扫描页面已离开目标画师主页');
        if (new URL(location.href).searchParams.get('filter') !== 'photo') throw new Error('X 离开了照片筛选页，请手动重试');
        const fresh = [];
        for (const tweet of cache.values()) {
          if (sent.has(tweet.id) || tweet.user !== job.handle || !tweet.photos.length) continue;
          sent.add(tweet.id);
          ownCount++;
          oldest = oldest == null ? tweet.created : Math.min(oldest, tweet.created);
          if (!tweet.reply && !tweet.repost && job.since && tweet.created < job.since) older.add(tweet.id);
          fresh.push(tweet);
        }
        const answer = await send({ type: 'scanBatch', jobId: job.id, tweets: fresh, oldest, seen: ownCount, diagnostics: diagnostics() });
        if (!answer?.ok) throw new Error(answer?.error || '扩展连接中断，请重试');
        if (job.since && older.size >= 3) {
          await send({ type: 'scanEnd', jobId: job.id, boundary: true, reason: '已扫描到起始时间之前的多条图片推文', diagnostics: diagnostics() });
          return;
        }
        const height = document.documentElement.scrollHeight;
        if (fresh.length || height > previousHeight + 20) stagnant = 0; else stagnant++;
        previousHeight = height;
        if (stagnant >= 10) {
          if (!ownCount) {
            if (!bridgeReady) throw new Error('照片页的数据监听器未连接，请重新加载扩展并刷新 X 页面后重试');
            if (responses.some(r => [401, 403, 429].includes(r.status))) throw new Error('X 接口拒绝访问或触发限流，请检查登录状态并稍后手动重试');
            throw new Error('照片页没有解析到目标账号的图片推文，已记录接口与筛选诊断；请导出记录排查');
          }
          if (job.kind === 'update' && older.size === 0) throw new Error('页面停止加载，但尚未覆盖上次检查时间；已保存获取的图片，请手动重试补查');
          await send({ type: 'scanEnd', jobId: job.id, boundary: older.size > 0, reason: '页面连续多次未加载更多内容；历史完整性未确认', diagnostics: diagnostics() });
          return;
        }
        window.scrollTo({ top: height, behavior: 'instant' });
        await pause(1800 + Math.random() * 700);
      }
      if (!state.stop) throw new Error('达到单次扫描上限，请稍后重试；已保存的图片会自动去重');
    } catch (error) {
      if (!state.stop) await send({ type: 'scanEnd', jobId: job.id, error: error.message, diagnostics: diagnostics() });
    } finally { if (running === state) running = null; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'beginScan') { respond({ ok: true }); scan(message.job); }
    else if (message.type === 'stopScan') { if (running) running.stop = true; respond({ ok: true }); }
    else if (message.type === 'pingScanner') respond({ ok: true });
  });
  async function updateToolbar() {
    const name = C.profileFromUrl(location.href);
    if (name !== toolbarHandle || !toolbar?.isConnected) {
      toolbar?.remove(); toolbar = null; toolbarHandle = name;
      if (!name) return;
      const anchor = document.querySelector('[data-testid="primaryColumn"] [data-testid="UserName"]');
      if (!anchor) return;
      toolbar = document.createElement('div');
      const shadow = toolbar.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;margin:12px 0}div{display:flex;gap:8px;flex-wrap:wrap}button{font:600 13px system-ui;border:1px solid #536471;border-radius:20px;padding:8px 13px;background:#0f1419;color:white;cursor:pointer}button:hover{background:#273340}';
      const row = document.createElement('div');
      const history = document.createElement('button'); history.textContent = '↓ 收藏历史原图';
      history.onclick = async () => {
        history.disabled = true;
        const result = await send({ type: 'startHistory', handle: name, since: 0, until: 0 });
        history.textContent = result?.ok ? '已加入下载队列 · 点击扩展查看' : result?.error || '请点击扩展重试';
        history.disabled = false;
      };
      const watch = document.createElement('button');
      const status = await send({ type: 'watchStatus', handle: name });
      let tracked = Boolean(status?.tracked);
      watch.textContent = tracked ? '✓ 已追踪 · 取消' : '+ 追踪每日更新';
      watch.onclick = async () => {
        watch.disabled = true;
        const result = await send({ type: 'toggleWatch', handle: name, enabled: !tracked });
        if (result?.ok) { tracked = !tracked; watch.textContent = tracked ? '✓ 已追踪 · 取消' : '+ 追踪每日更新'; }
        else watch.textContent = result?.error || '操作失败，请点击扩展';
        watch.disabled = false;
      };
      row.append(history, watch); shadow.append(style, row); anchor.after(toolbar);
    }
  }
  // X uses SPA navigation; poll lightly so profile actions follow the current account.
  setInterval(() => updateToolbar().catch(() => {}), 1800);
})();
