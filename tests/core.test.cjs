const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../core.js');

test('profile detection rejects non-profile pages and unsafe hosts', () => {
  assert.equal(C.profileFromUrl('https://x.com/Artist_1/media'), 'artist_1');
  for (const url of ['https://x.com/home', 'https://x.com/artist/status/123', 'https://evil.example/artist', 'not-a-url']) assert.equal(C.profileFromUrl(url), null);
});
test('photo scan entry explicitly selects photos instead of the default video category', () => {
  assert.equal(C.photoPageUrl('@FixtureArtist'), 'https://x.com/fixtureartist/media?filter=photo');
  assert.equal(C.profileFromUrl(C.photoPageUrl('fixtureartist')), 'fixtureartist');
  assert.throws(() => C.photoPageUrl('../home'));
});
test('migration backup validates, strips unrelated fields, and rejects unsafe media', () => {
  const now = Date.now() - 60000;
  const data = { format: 'x-art-backup', version: 1, watches: [{ handle: 'Artist', since: now, lastSuccess: null, token: 'must-not-copy' }],
    completed: [{ key: '1234567890_1', tweetId: '1234567890', handle: 'artist', created: now, index: 1, url: 'https://pbs.twimg.com/media/Art.png', filename: 'C:/private/path' }] };
  const result = C.validateBackup(data);
  assert.equal(result.watches[0].handle, 'artist');
  assert.equal(result.completed[0].url, 'https://pbs.twimg.com/media/Art?format=png&name=orig');
  assert.ok(!JSON.stringify(result).includes('must-not-copy'));
  assert.ok(!JSON.stringify(result).includes('C:/private'));
  assert.throws(() => C.validateBackup({ ...data, format: 'wrong' }));
  assert.throws(() => C.validateBackup({ ...data, watches: [{ handle: '__proto__', since: now }] }));
  assert.throws(() => C.validateBackup({ ...data, completed: [{ ...data.completed[0], url: 'https://evil.example/picture.png' }] }));
  assert.throws(() => C.validateBackup({ ...data, completed: [{ ...data.completed[0], key: 'mismatch' }] }));
});
test('original URL conversion preserves image format and never falls back to thumbnails', () => {
  assert.equal(C.originalUrl('https://pbs.twimg.com/media/Example.jpg'), 'https://pbs.twimg.com/media/Example?format=jpg&name=orig');
  assert.equal(C.originalUrl('https://pbs.twimg.com/media/Example?format=png&name=small'), 'https://pbs.twimg.com/media/Example?format=png&name=orig');
  for (const url of ['https://evil.example/a.jpg', 'http://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/profile_images/a.jpg', 'https://pbs.twimg.com/media/a?format=html']) assert.equal(C.originalUrl(url), null);
});
test('filter author, original posts, date boundaries, and invalid image URLs', () => {
  const raw = { id: '1234567890', user: 'Artist', createdAt: '2026-01-02T12:00:00Z', reply: false, repost: false, photos: [{ url: 'https://pbs.twimg.com/media/Test.png', index: 1, width: 4096, height: 2048 }] };
  const tweet = C.normalizeTweet(raw);
  const job = { handle: 'artist', since: Date.parse('2026-01-01'), until: Date.parse('2026-01-03') };
  assert.ok(C.eligible(tweet, job));
  for (const change of [{ user: 'other' }, { reply: true }, { repost: true }, { created: job.until }, { created: job.since - 1 }]) assert.equal(C.eligible({ ...tweet, ...change }, job), false);
  assert.equal(C.normalizeTweet({ ...raw, reply: undefined }), null);
  assert.equal(C.normalizeTweet({ ...raw, createdAt: 'invalid' }), null);
  assert.equal(C.normalizeTweet({ ...raw, photos: [{ url: 'https://evil.example/photo.jpg', index: 1 }] }).photos.length, 0);
});
test('filenames are stable, safe, and keep original resolution independent of naming', () => {
  const item = { handle: 'artist', tweetId: '1234567890', created: Date.parse('2026-01-02T12:03:04Z'), index: 2 };
  assert.equal(C.filename(item, 'png'), 'X-Art/artist/20260102_120304_1234567890_2.png');
  assert.throws(() => C.filename({ ...item, handle: '../escape' }, 'png'));
  assert.equal(C.imageKey(item.tweetId, 2), '1234567890_2');
});
test('posts with more than four images retain every photo and stable media indices', () => {
  const tweet = C.normalizeTweet({ id: '1234567890123456789', user: 'fixtureartist', createdAt: '2026-11-15T12:00:00Z', reply: false, repost: false,
    photos: Array.from({ length: 19 }, (_, i) => ({ url: `https://pbs.twimg.com/media/Art${i}.png`, index: i + 1, width: 4096, height: 2160 })) });
  assert.equal(tweet.photos.length, 19);
  assert.equal(tweet.photos.at(-1).index, 19);
  assert.equal(C.imageKey(tweet.id, 19), '1234567890123456789_19');
  assert.ok(C.filename({ handle: tweet.user, tweetId: tweet.id, created: tweet.created, index: 19 }, 'png').endsWith('_19.png'));
});
test('inclusive calendar ranges reject invalid or reversed dates', () => {
  assert.deepEqual(C.dateRange('', ''), { since: 0, until: 0 });
  const result = C.dateRange('2026-01-02', '2026-01-02');
  assert.equal(new Date(result.since).getDate(), 2);
  assert.equal(new Date(result.until).getDate(), 3);
  assert.throws(() => C.dateRange('2026-02-30', ''));
  assert.throws(() => C.dateRange('2026-02-03', '2026-02-01'));
});
test('network bridge extracts only original static media, skips quoted/reposted payloads, preserves fetch response', async () => {
  const posted = [];
  const photo = { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Art.jpg', original_info: { width: 6000, height: 4000 } };
  const tweet = id => ({ rest_id: id, core: { user_results: { result: { core: { screen_name: 'Artist' } } } }, legacy: { created_at: 'Fri Jan 02 12:00:00 +0000 2026', extended_entities: { media: [photo, { type: 'video' }] } } });
  const main = tweet('1234567890');
  main.quoted_status_result = { result: tweet('9999999999') };
  const repost = tweet('2234567890');
  repost.legacy.retweeted_status_result = { result: tweet('8888888888') };
  const payload = { data: { timeline: [main, repost] } };
  const response = { ok: true, headers: { get: () => 'application/json' }, clone: () => ({ json: async () => payload }) };
  function XHR() {}
  XHR.prototype.open = () => {}; XHR.prototype.send = () => {};
  const listeners = {};
  const win = { fetch: async () => response, postMessage: msg => posted.push(msg), addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8'), { window: win, XMLHttpRequest: XHR, URL, location: { origin: 'https://x.com' } });
  assert.equal(await win.fetch('https://x.com/i/api/graphql/id/UserMedia'), response);
  await new Promise(resolve => setImmediate(resolve));
  const observed = posted.find(msg => msg.tweets.length);
  assert.deepEqual(Array.from(observed.tweets, t => t.id), ['1234567890', '2234567890']);
  assert.equal(observed.tweets[0].photos.length, 1);
  assert.equal(observed.tweets[0].photos[0].width, 6000);
  assert.equal(observed.tweets[1].repost, true);
  assert.equal(observed.responses[0].endpoint, 'UserMedia');
  assert.equal(observed.responses[0].photos, 2);
  const count = posted.length;
  await win.fetch('https://evil.example/graphql/id/UserMedia');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.length, count);
  // The isolated scanner can attach after a fast initial response; replay only
  // already-observed data, without another network request or exposing tokens.
  listeners.message({ source: win, origin: 'https://x.com', data: { channel: 'x-art-request-replay-v1' } });
  assert.equal(posted.at(-1).tweets.length, 2);
  assert.equal(posted.at(-1).ready, true);
});
