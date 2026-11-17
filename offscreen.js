'use strict';
const blobs = new Map();
const controllers = new Map();
// Offscreen messages keep the MV3 worker available while a large original is
// still being fetched after its scanning tab has already closed.
setInterval(() => {
  if (controllers.size) chrome.runtime.sendMessage({ type: 'offscreenHeartbeat' }).catch(() => {});
}, 20000);
function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if ([137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return 'png';
  const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'release') {
    const url = blobs.get(message.token);
    if (url) URL.revokeObjectURL(url);
    blobs.delete(message.token);
    respond({ ok: true }); return;
  }
  if (message.type === 'abort') {
    controllers.get(message.token)?.abort();
    respond({ ok: true }); return;
  }
  if (message.type !== 'prepare') return;
  (async () => {
    const url = XArtCore.originalUrl(message.url);
    if (!url || url !== message.url) throw new Error('只允许获取 pbs.twimg.com 的 orig 图片');
    const controller = new AbortController();
    controllers.set(message.token, controller);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error(`原图请求失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const ext = sniff(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
      if (!ext) throw new Error('返回内容不是支持的静态图片');
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width, height = bitmap.height;
      bitmap.close();
      if (!width || !height) throw new Error('原图尺寸无效');
      if ((message.width && width < message.width) || (message.height && height < message.height)) throw new Error(`图片仅 ${width}×${height}，小于推文声明的原图尺寸，已跳过`);
      const blobUrl = URL.createObjectURL(blob);
      const previous = blobs.get(message.token);
      if (previous) URL.revokeObjectURL(previous);
      blobs.set(message.token, blobUrl);
      return { ok: true, url: blobUrl, width, height, bytes: blob.size, ext };
    } finally { clearTimeout(timer); controllers.delete(message.token); }
  })().then(respond, error => respond({ ok: false, error: error.name === 'AbortError' ? '原图请求已取消或超时' : error.message }));
  return true;
});
