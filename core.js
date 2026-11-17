/* Pure helpers shared by the worker, content script, and Node tests. */
(function (root) {
  'use strict';
  const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'login', 'logout', 'signup', 'intent', 'share', 'tos', 'privacy']);
  function handle(value) {
    const v = String(value || '').replace(/^@/, '').trim();
    return /^[a-zA-Z0-9_]{1,15}$/.test(v) && !reserved.has(v.toLowerCase()) && !['__proto__', 'constructor', 'prototype'].includes(v.toLowerCase()) ? v.toLowerCase() : null;
  }
  function profileFromUrl(value) {
    try {
      const u = new URL(value);
      if (!['x.com', 'twitter.com'].includes(u.hostname)) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 2 || (parts[1] && !['media', 'with_replies', 'highlights', 'articles'].includes(parts[1]))) return null;
      return handle(parts[0]);
    } catch { return null; }
  }
  function originalUrl(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.hostname !== 'pbs.twimg.com' || !/^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp))?$/.test(u.pathname)) return null;
      const ext = (u.searchParams.get('format') || u.pathname.match(/\.(jpg|jpeg|png|webp)$/)?.[1] || '').toLowerCase();
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return null;
      const base = u.pathname.replace(/\.(jpg|jpeg|png|webp)$/, '');
      return `https://pbs.twimg.com${base}?format=${ext}&name=orig`;
    } catch { return null; }
  }
  function photoPageUrl(name) {
    const artist = handle(name);
    if (!artist) throw new Error('画师账号无效');
    return `https://x.com/${artist}/media?filter=photo`;
  }
  function normalizeTweet(raw) {
    if (!raw || !/^\d{5,25}$/.test(String(raw.id)) || !handle(raw.user)) return null;
    const created = Date.parse(raw.createdAt);
    if (!Number.isFinite(created) || created < 1142899200000 || created > Date.now() + 86400000) return null;
    if (typeof raw.reply !== 'boolean' || typeof raw.repost !== 'boolean') return null;
    const photos = (Array.isArray(raw.photos) ? raw.photos : []).slice(0, 100).map((p, i) => {
      const url = originalUrl(p.url);
      const index = Number(p.index);
      return url && Number.isInteger(index) && index >= 1 && index <= 100 ? {
        url, index, width: Math.max(0, Number(p.width) || 0), height: Math.max(0, Number(p.height) || 0)
      } : null;
    }).filter(Boolean);
    return { id: String(raw.id), user: handle(raw.user), created, reply: raw.reply, repost: raw.repost, photos };
  }
  function eligible(tweet, job) {
    return tweet.user === job.handle && !tweet.reply && !tweet.repost &&
      tweet.created >= (job.since || 0) && tweet.created < (job.until || Infinity);
  }
  function imageKey(tweetId, index) { return `${tweetId}_${index}`; }
  function filename(item, ext) {
    const date = new Date(item.created).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    if (!handle(item.handle) || !/^\d{5,25}$/.test(item.tweetId) || !['jpg', 'png', 'webp', 'gif'].includes(ext)) throw new Error('文件名参数无效');
    return `X-Art/${handle(item.handle)}/${date}_${item.tweetId}_${item.index}.${ext}`;
  }
  function localDay(time = Date.now()) {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dateRange(from, through) {
    const parse = (s) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日期格式无效');
      const d = new Date(`${s}T00:00:00`);
      if (!Number.isFinite(+d) || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== s) throw new Error('日期无效');
      return d;
    };
    const since = from ? +parse(from) : 0;
    let until = 0;
    if (through) { const d = parse(through); d.setDate(d.getDate() + 1); until = +d; }
    if (until && since >= until) throw new Error('开始日期必须早于或等于结束日期');
    return { since, until };
  }
  const MAX_WATCHES = 200;
  function validateBackup(data) {
    if (data?.format !== 'x-art-backup' || data.version !== 1 || !Array.isArray(data.watches) || !Array.isArray(data.completed) || data.watches.length > MAX_WATCHES || data.completed.length > 100000) throw new Error('备份格式或数量无效');
    const validTime = value => Number.isFinite(value) && value >= 1142899200000 && value <= Date.now() + 86400000;
    const watches = data.watches.map(w => {
      const name = handle(w?.handle);
      if (!name || !validTime(w.since) || (w.lastSuccess != null && (!validTime(w.lastSuccess) || w.lastSuccess < w.since))) throw new Error('备份中的追踪时间或账号无效');
      return { handle: name, since: w.since, lastSuccess: w.lastSuccess ?? null };
    });
    const completed = data.completed.map(i => {
      const tweet = normalizeTweet({ id: i?.tweetId, user: i?.handle, createdAt: validTime(i?.created) ? new Date(i.created).toISOString() : '', reply: false, repost: false, photos: [{ url: i?.url, index: i?.index, width: i?.width, height: i?.height }] });
      if (!tweet || tweet.photos.length !== 1 || i.key !== imageKey(tweet.id, tweet.photos[0].index)) throw new Error('备份中的图片记录无效');
      const photo = tweet.photos[0];
      return { key: i.key, handle: tweet.user, tweetId: tweet.id, index: photo.index, created: tweet.created, url: photo.url, width: photo.width, height: photo.height,
        actualWidth: Math.max(0, Number(i.actualWidth) || 0), actualHeight: Math.max(0, Number(i.actualHeight) || 0), bytes: Math.max(0, Number(i.bytes) || 0), completed: validTime(i.completed) ? i.completed : Date.now() };
    });
    return { watches, completed };
  }
  const api = { MAX_WATCHES, validateBackup, handle, profileFromUrl, photoPageUrl, originalUrl, normalizeTweet, eligible, imageKey, filename, localDay, dateRange };
  root.XArtCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
