import puppeteer from 'puppeteer-core';
const URL_ = process.argv[2] || 'https://kshbl0815.github.io/plaud-minutes/';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const out = {};
try {
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', async (m) => { if (m.type() === 'error') errs.push(m.text() + ' | ' + (m.location()?.url || '') + ' | ' + (await Promise.all(m.args().map((a) => a.evaluate((x) => (x && x.stack) || String(x)).catch(() => '')))).join(' ')); });
  await page.goto(URL_, { waitUntil: 'networkidle0' });
  out.title = await page.title();
  out.tabbar = await page.$$eval('.tabbar a', (a) => a.length);
  const cdp = await page.createCDPSession();
  const man = await cdp.send('Page.getAppManifest');
  out.manifestUrl = man.url; out.manifestErrors = man.errors;
  const pm = man.parsed || JSON.parse(man.data);
  out.parsed = man.parsed ? { start_url: man.parsed.startUrl ?? man.parsed.start_url, scope: man.parsed.scope, keys: Object.keys(man.parsed) } : null;
  try { const inst = await cdp.send('Page.getInstallabilityErrors'); out.installabilityErrors = inst.installabilityErrors; } catch (e) { out.installabilityErrors = 'n/a ' + e.message; }
  await page.evaluate(() => navigator.serviceWorker.ready);
  out.swScope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
  await page.reload({ waitUntil: 'networkidle0' });
  out.controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  // share target POST (resolved from manifest action, relative to manifest URL)
  out.share = await page.evaluate(async () => {
    const m = await (await fetch('manifest.webmanifest')).json();
    const action = new URL(m.share_target.action, new URL('manifest.webmanifest', location.href)).href;
    const fd = new FormData();
    fd.append('audio', new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], '2026-10-07 10_00_00.mp3', { type: 'audio/mpeg' }));
    const r = await fetch(action, { method: 'POST', body: fd });
    return { action, status: r.status, finalUrl: r.url, redirected: r.redirected };
  });
  await page.goto(URL_ + '#/import?shared=1', { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  out.sharedImported = await page.evaluate(() => window.__pm.meetings().some((m) => m.fileName === '2026-10-07 10_00_00.mp3'));
  // offline load from SW cache
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  out.offlineTabbar = await page.$$eval('.tabbar a', (a) => a.length);
  await page.setOfflineMode(false);
  out.consoleErrors = errs;
} finally { await b.close(); }
console.log(JSON.stringify(out, null, 2));
