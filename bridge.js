/* Observe only responses already requested by X. No private API tokens or extra API calls. */
(() => {
  'use strict';
  const channel = 'x-art-observed-v1';
  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const requestUrls = new WeakMap();
  const recentTweets = new Map();
  const responses = [];
  function emit(tweets = []) {
    window.postMessage({ channel, tweets, responses: responses.slice(-12), ready: true }, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === 'x-art-request-replay-v1') {
      emit([...recentTweets.values()]);
    }
  });
  function record(url, status, result) {
    const endpoint = new URL(url, location.origin).pathname.split('/').pop().slice(0, 100);
    responses.push({ endpoint, status, ...result });
    if (responses.length > 12) responses.shift();
    emit();
  }
  function relevant(value) {
    try { const u = new URL(value, location.origin); return ['x.com', 'twitter.com'].includes(u.hostname) && /\/graphql\//.test(u.pathname); }
    catch { return false; }
  }
  function publish(json, url, status) {
    const tweets = new Map();
    let budget = 50000;
    function visit(obj, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 45 || --budget < 0) return;
      const legacy = obj.legacy;
      const user = obj.core?.user_results?.result;
      if (obj.rest_id && legacy?.created_at && user) {
        const media = legacy.extended_entities?.media || [];
        const name = user.core?.screen_name || user.legacy?.screen_name;
        if (name) tweets.set(String(obj.rest_id), {
          id: String(obj.rest_id), user: name, createdAt: legacy.created_at,
          reply: Boolean(legacy.in_reply_to_status_id_str || legacy.in_reply_to_user_id_str),
          repost: Boolean(legacy.retweeted_status_result || legacy.retweeted_status_id_str),
          photos: media.map((m, index) => ({ m, index })).filter(({ m }) => m.type === 'photo').map(({ m, index }) => ({
            url: m.media_url_https, index: index + 1,
            width: m.original_info?.width || m.sizes?.large?.w || 0,
            height: m.original_info?.height || m.sizes?.large?.h || 0
          }))
        });
      }
      // Quoted tweets are not timeline entries and must not trigger downloads.
      for (const key of Object.keys(obj)) {
        if (['quoted_status_result', 'retweeted_status_result', 'quotedRefResult'].includes(key)) continue;
        visit(obj[key], depth + 1);
      }
    }
    visit(json);
    for (const [id, tweet] of tweets) recentTweets.set(id, tweet);
    while (recentTweets.size > 1000) recentTweets.delete(recentTweets.keys().next().value);
    const values = [...tweets.values()];
    responses.push({ endpoint: new URL(url, location.origin).pathname.split('/').pop().slice(0, 100), status, tweets: values.length, photos: values.reduce((sum, t) => sum + t.photos.length, 0) });
    if (responses.length > 12) responses.shift();
    emit(values);
  }
  window.fetch = function (...args) {
    const result = Reflect.apply(nativeFetch, this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0]?.url;
    if (relevant(url)) result.then(response => {
      if (response.ok && (response.headers.get('content-type') || '').includes('json')) {
        response.clone().json().then(json => publish(json, url, response.status)).catch(() => record(url, response.status, { error: 'JSON 解析失败' }));
      } else record(url, response.status, { error: response.ok ? '非 JSON 响应' : 'HTTP 请求失败' });
    }).catch(() => record(url, 0, { error: '网络请求失败' }));
    return result;
  };
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requestUrls.set(this, url);
    return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (relevant(requestUrls.get(this))) this.addEventListener('load', () => {
      try {
        if (this.status >= 200 && this.status < 300) publish(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), requestUrls.get(this), this.status);
        else record(requestUrls.get(this), this.status, { error: 'HTTP 请求失败' });
      } catch { record(requestUrls.get(this), this.status, { error: 'JSON 解析失败' }); }
    }, { once: true });
    return Reflect.apply(nativeSend, this, args);
  };
  emit();
})();
