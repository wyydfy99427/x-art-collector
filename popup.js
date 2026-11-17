'use strict';
const $ = id => document.getElementById(id);
const C = XArtCore;
let snapshot = { watches: [], jobs: [] };
let refreshing = false;
let renderingKey = '';
let includeHidden = false;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展未响应，请重新打开弹窗');
  return result;
}
function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action) {
  const node = element('button', text, 'text-button');
  node.type = 'button';
  node.onclick = async () => {
    node.disabled = true;
    try { await action(); renderingKey = ''; await refresh(); }
    catch (error) { notify(error.message, true); }
    finally { node.disabled = false; }
  };
  return node;
}
function profileLink(name) {
  const a = element('a', `@${name}`); a.href = `https://x.com/${name}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function updateWatchButton() {
  const name = C.handle($('artist').value);
  $('toggle-watch').disabled = !name;
  $('toggle-watch').textContent = snapshot.watches.some(w => w.handle === name) ? '✓ 已追踪 · 点击取消' : '+ 追踪每日更新';
}
function render(data) {
  snapshot = data;
  updateWatchButton();
  const key = JSON.stringify([data.watches, data.jobs, data.lastAutoDay, data.maxWatches]);
  if (key === renderingKey) return;
  renderingKey = key;
  $('watch-count').textContent = `${data.watches.length} / ${data.maxWatches || C.MAX_WATCHES}`;
  $('auto-status').textContent = data.lastAutoDay
    ? `最近自动检查启动于 ${data.lastAutoDay}；各画师结果见任务记录。`
    : '尚未触发启动检查；完全退出后重新启动 Chrome，或点击下方立即检查。';
  $('watches').replaceChildren();
  if (!data.watches.length) $('watches').append(element('p', '尚未追踪画师，输入账号后点击“追踪每日更新”。', 'empty'));
  for (const watch of data.watches) {
    const row = element('div', null, 'watch');
    row.append(profileLink(watch.handle));
    row.append(element('p', watch.lastSuccess ? `上次成功：${new Date(watch.lastSuccess).toLocaleString()}` : `从 ${new Date(watch.since).toLocaleString()} 开始追踪`, 'description'));
    const actions = element('div', null, 'actions');
    actions.append(button('立即检查 / 重试', async () => { await send({ type: 'checkNow', handle: watch.handle }); notify('已加入检查队列。'); }));
    actions.append(button('取消追踪', () => send({ type: 'toggleWatch', handle: watch.handle, enabled: false })));
    row.append(actions); $('watches').append(row);
  }
  $('jobs').replaceChildren();
  if (!data.jobs.length) $('jobs').append(element('p', '还没有下载任务。', 'empty'));
  const statuses = { queued: '排队中', scanning: '扫描中', downloading: '下载中', complete: '已完成', partial: '部分原图失败', failed: '检查失败', cancelled: '已停止' };
  for (const job of data.jobs) {
    const card = element('div', null, 'job');
    const heading = element('div', null, 'row');
    heading.append(profileLink(job.handle), element('span', statuses[job.status] || job.status, `status ${job.status}`));
    card.append(heading);
    card.append(element('p', `${job.kind === 'history' ? '历史收藏' : '更新检查'} · ${new Date(job.created).toLocaleString()}`, 'description'));
    card.append(element('p', `扫描 ${job.seen} 条 · 已保存或已有 ${job.counts.complete} 张 · 待处理 ${job.counts.pending} 张 · 失败 ${job.counts.failed} 张`, 'description'));
    if (job.oldest) card.append(element('p', `已读到：${new Date(job.oldest).toLocaleString()}`, 'description'));
    if (job.hidden) card.append(element('p', '后台保留记录 · 已从默认列表隐藏', 'description'));
    if (job.note) card.append(element('p', job.note, 'description'));
    if (job.error) card.append(element('p', job.error, 'description error'));
    if (job.kind === 'history' && job.status === 'complete') card.append(element('p', '已获取当前可访问内容；历史完整性未确认。', 'description'));
    if (job.failures.length) {
      const details = element('details', null, 'failures');
      details.append(element('summary', `查看失败图片（显示前 ${job.failures.length} 条）`));
      for (const failure of job.failures) {
        const p = element('p');
        const link = element('a', failure.key); link.href = failure.source; link.target = '_blank'; link.rel = 'noopener noreferrer';
        p.append(link, document.createTextNode(`：${failure.error}`)); details.append(p);
      }
      card.append(details);
    }
    const actions = element('div', null, 'actions');
    if (['partial', 'failed'].includes(job.status)) actions.append(button('手动重试', async () => { await send({ type: 'retryJob', id: job.id }); notify('已重试；成功保存的图片会跳过。'); }));
    if (!['complete', 'cancelled'].includes(job.status)) actions.append(button(['partial', 'failed'].includes(job.status) ? '忽略此任务' : '停止任务', () => send({ type: 'cancelJob', id: job.id })));
    card.append(actions); $('jobs').append(card);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { render(await send({ type: 'getState', includeHidden })); }
  catch (error) { notify(error.message, true); }
  finally { refreshing = false; }
}
$('artist').addEventListener('input', updateWatchButton);
$('history-form').onsubmit = async event => {
  event.preventDefault();
  const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true;
  try {
    const name = C.handle($('artist').value);
    if (!name) throw new Error('请输入有效的画师账号，不含完整链接');
    const range = C.dateRange($('from').value, $('through').value);
    await send({ type: 'startHistory', handle: name, ...range, force: $('force').checked });
    notify('已加入队列。扫描会打开临时标签页，请保持该标签页开启。');
    await refresh();
  } catch (error) { notify(error.message, true); }
  finally { submit.disabled = false; }
};
$('toggle-watch').onclick = async () => {
  const name = C.handle($('artist').value); if (!name) return;
  try {
    const enabled = !snapshot.watches.some(w => w.handle === name);
    await send({ type: 'toggleWatch', handle: name, enabled });
    notify(enabled ? '已开启追踪；下次启动 Chrome 时检查，新图从现在起计。' : '已取消追踪。');
    await refresh();
  } catch (error) { notify(error.message, true); }
};
$('downloads').onclick = () => send({ type: 'showDownloads' }).catch(e => notify(e.message, true));
function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('clear-records').onclick = async () => {
  const button = $('clear-records'); button.disabled = true;
  try {
    const result = await send({ type: 'clearVisibleRecords' });
    includeHidden = false; $('show-archive').textContent = '查看后台记录'; renderingKey = '';
    notify(`已隐藏 ${result.cleared} 条记录；后台检查和去重继续保留。`); await refresh();
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
};
$('show-archive').onclick = async () => {
  includeHidden = !includeHidden; renderingKey = '';
  $('show-archive').textContent = includeHidden ? '返回当前记录' : '查看后台记录'; await refresh();
};
$('export-backup').onclick = async () => {
  try { const { data } = await send({ type: 'exportBackup' }); downloadJson(data, `x-art-backup-${C.localDay()}.json`); }
  catch (error) { notify(error.message, true); }
};
$('import-backup').onclick = () => $('backup-file').click();
$('backup-file').onchange = async () => {
  const file = $('backup-file').files[0]; if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('备份文件超过 50 MB');
    const data = JSON.parse(await file.text());
    C.validateBackup(data);
    const result = await send({ type: 'importBackup', data });
    notify(`已合并 ${result.watches} 位画师、${result.completed} 条已下载索引。请确保图片文件已另外迁移。`);
    renderingKey = ''; await refresh();
  } catch (error) { notify(error.message, true); }
  finally { $('backup-file').value = ''; }
};
$('export-log').onclick = async () => {
  try {
    const { data } = await send({ type: 'exportLog' });
    downloadJson(data, `x-art-log-${C.localDay()}.json`);
  } catch (error) { notify(error.message, true); }
};
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const name = C.profileFromUrl(tab?.url || '');
    if (name) $('artist').value = name;
  } catch { /* Account entry remains available without an active X tab. */ }
  await refresh(); setInterval(refresh, 2000);
})();
