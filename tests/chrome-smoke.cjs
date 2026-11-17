/* Real Chrome MV3 / IndexedDB / Blob-download integration against synthetic X fixtures.
   Uses an isolated temporary browser profile; never reads the user's Chrome profile. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ext = path.resolve(__dirname, '..');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'x-art-chrome-'));
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, acceptDownloads: true, downloadsPath: path.join(temp, 'downloads'),
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  try {
    const browserSession = await context.browser().newBrowserCDPSession();
    const { id } = await browserSession.send('Extensions.loadUnpacked', { path: ext });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.__downloadNames = [];
      const original = chrome.downloads.download.bind(chrome.downloads);
      chrome.downloads.download = options => { globalThis.__downloadNames.push(options.filename); return original(options); };
      globalThis.__scanUrls = [];
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = options => { globalThis.__scanUrls.push(options.url); return create(options); };
    });
    const errors = [];
    let fixtureScanning = false;
    context.on('page', page => {
      page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
      // Chrome's extension-created first navigation precedes Playwright's target routing.
      // Re-navigate the isolated test target once routing is attached.
      if (fixtureScanning) {
        setTimeout(() => { if (!page.isClosed() && fixtureScanning) page.goto('https://x.com/artist/media?filter=photo').catch(() => {}); }, 300);
      }
    });
    worker.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    popup.on('pageerror', error => errors.push(error.message));
    const png = await popup.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 4096; canvas.height = 2160;
      canvas.getContext('2d').fillRect(0, 0, 4096, 2160);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const largerPng = await popup.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 6000; canvas.height = 2160;
      canvas.getContext('2d').fillRect(0, 0, 6000, 2160);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    // Offscreen documents are not Playwright pages; install image fixtures through
    // CDP in that isolated extension document, retaining actual Blob decoding/downloads.
    await worker.evaluate(() => chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Isolated integration test' }));
    const { targetInfos } = await browserSession.send('Target.getTargets');
    const target = targetInfos.find(t => t.url === `chrome-extension://${id}/offscreen.html`);
    assert.ok(target, 'offscreen document target');
    const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    let commandId = 0;
    const offscreenEval = expression => new Promise((resolve, reject) => {
      const requestId = ++commandId;
      const listener = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== requestId) return;
        browserSession.off('Target.receivedMessageFromTarget', listener);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else resolve(message.result?.result?.value);
      };
      browserSession.on('Target.receivedMessageFromTarget', listener);
      browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }) }).catch(reject);
    });
    await offscreenEval(`window.__fail=true;window.__requests=[];window.fetch=async url=>{window.__requests.push(url);if(window.__fail&&url.includes('/Missing?'))return new Response('missing',{status:404});const data=!window.__fail&&url.includes('/TooSmall?')?${JSON.stringify(largerPng)}:${JSON.stringify(png)};return new Response(Uint8Array.from(atob(data),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});};true`);
    let fail = true;
    const imageRequests = [];
    await context.route('https://pbs.twimg.com/**', async route => {
      imageRequests.push(route.request().url());
      if (fail && route.request().url().includes('/Missing?')) return route.fulfill({ status: 404, body: 'Not found' });
      await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(png, 'base64') });
    });
    const created = Date.now() - 3600000;
    let updateTweets = [];
    const raw = (id, when = created, user = 'artist', media = 'Art', reply = false) => ({
      rest_id: id, core: { user_results: { result: { core: { screen_name: user } } } },
      legacy: { created_at: new Date(when).toUTCString(), in_reply_to_status_id_str: reply ? '1234567890' : null,
        extended_entities: { media: media ? [{ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${media}.png`, original_info: { width: media === 'TooSmall' && fail ? 6000 : 4096, height: 2160 } }] : [] }
      }
    });
    await context.route('https://x.com/**', async route => {
      if (route.request().url().includes('/graphql/')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [
          raw('12345678901'), raw('12345678902', created, 'artist', 'TooSmall'), raw('12345678903', created, 'artist', 'Missing'),
          raw('12345678904', created, 'other'), raw('12345678905', created, 'artist', 'Reply', true),
          raw('12345678906', created - 172800000, 'artist', 'Older'), raw('12345678907', created - 172800001, 'artist', 'Older'), raw('12345678908', created - 172800002, 'artist', 'Older'),
          ...updateTweets
        ] }) });
      }
      // Regression: /media now defaults to videos and exposes no photo data.
      const photoPage = new URL(route.request().url()).searchParams.get('filter') === 'photo';
      return route.fulfill({ contentType: 'text/html', body: photoPage
        ? '<!doctype html><html><head><meta charset="utf-8"></head><body><main data-testid="primaryColumn"><div data-testid="UserName">Artist</div><div role="tab" aria-selected="true">照片</div></main><script>setTimeout(()=>fetch("/i/api/graphql/fixture/UserMedia?variables=private-test-token"),500)</script></body></html>'
        : '<!doctype html><html><head><meta charset="utf-8"></head><body><main data-testid="primaryColumn"><div data-testid="UserName">Artist</div><div role="tab" aria-selected="true">视频</div></main></body></html>' });
    });
    const message = data => popup.evaluate(data => chrome.runtime.sendMessage(data), data);
    const waitJob = async (id, status) => {
      for (let i = 0; i < 160; i++) {
        const data = await message({ type: 'getState' });
        assert.equal(data.ok, true, data.error);
        const job = data.jobs.find(j => j.id === id);
        if (status.includes(job?.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      for (const page of context.pages()) console.error('PAGE', page.url(), await page.evaluate(() => ({ ready: document.readyState, core: Boolean(globalThis.XArtCore), text: document.body?.innerText.slice(0, 500) })).catch(e => e.message));
      console.error('PING', await worker.evaluate(async () => { const job = state.jobs.find(j => j.status === 'scanning'); try { return await chrome.tabs.sendMessage(job.tabId, { type: 'pingScanner' }); } catch(e) { return e.message; } }));
      throw new Error(`Timed out: ${JSON.stringify(await message({ type: 'getState' }))}`);
    };
    fixtureScanning = true;
    const result = await message({ type: 'startHistory', handle: 'artist', since: created - 86400000, until: 0 });
    assert.equal(result.ok, true, result.error);
    const partial = await waitJob(result.jobId, ['partial', 'failed']);
    assert.equal(partial.status, 'partial', JSON.stringify(partial));
    assert.equal(partial.counts.total, 3, 'exclude replies and other authors');
    assert.equal(partial.counts.complete, 1, JSON.stringify(partial));
    assert.equal(partial.counts.failed, 2);
    assert.equal(partial.diagnostics.photoFilter, true);
    assert.ok((await worker.evaluate(() => globalThis.__scanUrls)).every(url => url.endsWith('/media?filter=photo')));
    assert.ok(partial.diagnostics.page.endsWith('/media?filter=photo'));
    assert.deepEqual(partial.diagnostics.selectedTabs, ['照片']);
    assert.equal(partial.diagnostics.bridgeReady, true);
    assert.ok(partial.diagnostics.responses.some(r => r.endpoint === 'UserMedia' && r.photos > 0));
    assert.ok(!JSON.stringify(partial.diagnostics).includes('private-test-token'), 'diagnostics must exclude request queries and credentials');
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '!');
    const beforeClear = await message({ type: 'getState' });
    await popup.locator('#clear-records').click();
    assert.equal((await message({ type: 'getState' })).jobs.length, 0, 'clear button hides records');
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '', 'acknowledged hidden failure badge clears');
    const archived = await message({ type: 'getState', includeHidden: true });
    assert.equal(archived.jobs[0].id, partial.id);
    assert.equal(archived.jobs[0].status, 'partial', 'clearing UI does not discard failed images');
    assert.equal(archived.jobs[0].counts.failed, beforeClear.jobs[0].counts.failed);
    assert.ok(await worker.evaluate(id => records('readonly', store => store.get(id), 'taskArchive'), partial.id));
    await popup.locator('#show-archive').click();
    assert.match(await popup.locator('#jobs').innerText(), /部分原图失败/);
    await popup.locator('#show-archive').click();
    fail = false;
    await offscreenEval('window.__fail=false;true');
    assert.equal((await message({ type: 'retryJob', id: result.jobId })).ok, true);
    const completed = await waitJob(result.jobId, ['complete']);
    assert.equal(completed.counts.complete, 3);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '');
    imageRequests.push(...await offscreenEval('window.__requests'));
    assert.ok(imageRequests.every(url => new URL(url).searchParams.get('name') === 'orig'));
    assert.equal(imageRequests.filter(url => url.includes('/Art?')).length, 1, 'retry must not redownload saved original');
    const downloads = await worker.evaluate(() => chrome.downloads.search({}));
    assert.equal(downloads.filter(d => d.state === 'complete').length, 3);
    // Playwright stores accepted downloads under UUIDs; assert the filename handed
    // to the real Chrome downloads API before its test-only acceptance override.
    const names = await worker.evaluate(() => globalThis.__downloadNames);
    assert.ok(names.every(name => /^X-Art\/artist\/\d{8}_\d{6}_\d+_\d{1,3}\.png$/.test(name)), JSON.stringify(names));
    const dimensions = await worker.evaluate(async () => (await byJob(state.jobs[0].id)).map(i => [i.actualWidth, i.actualHeight]));
    assert.ok(dimensions.every(([w, h]) => w >= 4096 && h === 2160));
    const second = await message({ type: 'startHistory', handle: 'artist', since: created - 86400000, until: 0 });
    await waitJob(second.jobId, ['complete']);
    assert.equal((await offscreenEval('window.__requests')).length, 5, 'second scan must use durable deduplication');
    const jobsBeforeWatch = (await message({ type: 'getState' })).jobs.length;
    assert.equal((await message({ type: 'toggleWatch', handle: 'artist', enabled: true })).ok, true);
    let watchData = await message({ type: 'getState' });
    assert.equal(watchData.jobs.length, jobsBeforeWatch, 'enabling tracking does not start a historical download');
    const trackedSince = watchData.watches[0].since;
    // Publish an unseen image after tracking starts. Preserve its real tracking
    // timestamp; prior tests only rescanned previously downloaded image IDs.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const newPostTime = Date.now();
    updateTweets = [raw('32345678901', newPostTime, 'artist', 'NewTrackedArt')];
    await new Promise(resolve => setTimeout(resolve, 20));
    await worker.evaluate(() => dailyStartup());
    let data = await message({ type: 'getState' });
    const update = data.jobs.find(j => j.kind === 'update');
    const autoCompleted = await waitJob(update.id, ['complete']);
    assert.equal(autoCompleted.since, trackedSince);
    assert.equal(autoCompleted.counts.total, 1, 'automatic check includes new posts only');
    assert.equal(autoCompleted.counts.complete, 1, 'new unseen original actually downloaded');
    assert.equal((await offscreenEval('window.__requests')).filter(url => url.includes('/NewTrackedArt?')).length, 1);
    const trackedImage = await worker.evaluate(() => getImage('32345678901_1'));
    assert.equal(trackedImage.status, 'complete');
    assert.equal(trackedImage.actualWidth, 4096);
    assert.equal((await message({ type: 'getState' })).watches[0].lastSuccess, autoCompleted.cutoff, 'advance cursor only after saving originals');
    const beforeBackup = await message({ type: 'exportBackup' });
    assert.equal(beforeBackup.data.completed.length, 4);
    assert.ok(!JSON.stringify(beforeBackup).includes(temp), 'portable backup omits local absolute paths');
    assert.equal((await message({ type: 'importBackup', data: beforeBackup.data })).ok, true, 'backup merges idempotently');
    assert.equal((await message({ type: 'exportBackup' })).data.completed.length, 4);
    const before = (await message({ type: 'getState' })).jobs.length;
    await worker.evaluate(() => dailyStartup());
    assert.equal((await message({ type: 'getState' })).jobs.length, before, 'startup runs once per local calendar day');
    assert.equal((await offscreenEval('window.__requests')).length, 6, 'same-day startup downloads nothing again');
    // Exercise the user-facing API across the old limit and the new boundary.
    for (let i = 1; i < 200; i++) assert.equal((await message({ type: 'toggleWatch', handle: `watch_${i}`, enabled: true })).ok, true);
    watchData = await message({ type: 'getState' });
    assert.equal(watchData.maxWatches, 200);
    assert.equal(watchData.watches.length, 200);
    assert.equal((await message({ type: 'toggleWatch', handle: 'artist', enabled: true })).ok, true, 're-enabling an existing watch is idempotent at capacity');
    const overflow = await message({ type: 'toggleWatch', handle: 'overflow', enabled: true });
    assert.equal(overflow.ok, false);
    assert.match(overflow.error, /200/);
    await popup.reload();
    assert.equal(await popup.locator('#watch-count').textContent(), '200 / 200');
    // Isolate bulk startup scheduling without opening 200 real tabs. The real
    // scanning and download pipeline above is tested separately with new media.
    await worker.evaluate(async () => {
      globalThis.__preservedJobs = state.jobs.slice();
      globalThis.__preservedDay = state.lastAutoDay;
      scanLock = true; state.lastAutoDay = null;
      await dailyStartup();
    });
    assert.equal(await worker.evaluate(() => state.jobs.filter(j => j.status === 'queued' && j.kind === 'update').length), 200, 'all 200 watches receive automatic update jobs');
    await worker.evaluate(async () => {
      state.jobs = globalThis.__preservedJobs; state.lastAutoDay = globalThis.__preservedDay;
      scanLock = false; await save(); await ensureAlarm(); await badge();
    });
    for (let i = 1; i < 200; i++) await message({ type: 'toggleWatch', handle: `watch_${i}`, enabled: false });
    const cancelled = await message({ type: 'startHistory', handle: 'artist', since: created - 86400000, until: 0 });
    await message({ type: 'cancelJob', id: cancelled.jobId });
    await waitJob(cancelled.jobId, ['cancelled']);
    assert.equal((await offscreenEval('window.__requests')).length, 6, 'cancellation preserves completed images');
    // Force MV3 worker re-creation. Deduplication must survive memory loss.
    fixtureScanning = false;
    const pageSession = await context.newCDPSession(popup);
    await pageSession.send('ServiceWorker.enable');
    await pageSession.send('ServiceWorker.stopAllWorkers');
    await popup.reload();
    assert.equal((await message({ type: 'getState' })).watches.length, 1, 'watch list persists');
    const stateAfterReload = await message({ type: 'getState' });
    assert.equal(stateAfterReload.jobs.filter(j => j.status === 'complete').length, 3, 'completed tasks persist');
    const migrationBackup = (await message({ type: 'exportBackup' })).data;
    const cursorBeforeClear = stateAfterReload.watches[0].lastSuccess;
    await message({ type: 'clearVisibleRecords' });
    const cleared = await message({ type: 'getState' });
    assert.equal(cleared.jobs.length, 0);
    assert.equal(cleared.watches[0].lastSuccess, cursorBeforeClear, 'clear preserves update cursor');
    const countBeforeRestart = await worker.evaluate(() => state.jobs.length);
    await worker.evaluate(() => dailyStartup());
    assert.equal(await worker.evaluate(() => state.jobs.length), countBeforeRestart, 'clear preserves daily guard');
    // Import into a truly empty extension database in this isolated profile.
    const freshWorker = context.serviceWorkers()[0];
    assert.ok(freshWorker);
    await freshWorker.evaluate(async () => {
      await records('readwrite', store => store.clear());
      await records('readwrite', store => store.clear(), 'taskArchive');
      state = { version: 1, watches: {}, jobs: [], lastAutoDay: null }; await save();
    });
    assert.equal((await message({ type: 'importBackup', data: migrationBackup })).ok, true);
    const imported = await message({ type: 'getState' });
    assert.equal(imported.watches.length, 1);
    assert.equal(imported.watches[0].lastSuccess, cursorBeforeClear);
    assert.equal((await message({ type: 'exportBackup' })).data.completed.length, 4, 'migration restores complete image index');
    assert.equal(imported.jobs.length, 0, 'migration excludes old machine tasks');
    fixtureScanning = true;
    const migratedScan = await message({ type: 'startHistory', handle: 'artist', since: created - 86400000, until: 0 });
    const migratedComplete = await waitJob(migratedScan.jobId, ['complete']);
    assert.equal(migratedComplete.counts.complete, 4, 'imported image index deduplicates all four originals');
    assert.equal(migratedComplete.counts.failed, 0);
    fixtureScanning = false;
    await message({ type: 'clearVisibleRecords' });
    await popup.reload();
    await popup.screenshot({ path: path.join(ext, 'tests', 'popup-smoke.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: clear-visible button archives failures, clears badge, preserves retry/cursor/daily guard; migration backup round-trip into empty database and deduplication; 200-watch scheduling; new-original automatic download; photo filtering; quality validation; cancellation; worker persistence.');
    console.log(`Isolated test profile and downloads: ${temp}`);
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
