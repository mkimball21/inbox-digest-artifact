const { chromium } = require('playwright');

// M4: a real, zero-email report (matching inbox_compilation_updated.gs's
// documented output shape for a quiet day: "(no emails found)" in the
// inventory, "No emails found for the covered window." in the appendix,
// zero EMAIL START/END blocks) should render a clear message, distinct
// from the not-found state.
const EMPTY_REPORT = `HEADER
Run Timestamp: 2026-08-27 04:06:00
Date Covered: 2026-08-27
Time Window: 2026-08-27 00:00:00 to 2026-08-27 23:59:59
Total Emails: 0
Total Threads: 0

INVENTORY
(no emails found)

--------------------------------------------------

DETAILED APPENDIX
No emails found for the covered window.`;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('http://127.0.0.1:8934/index.html');

  // --- M4: queue the empty report, select a date, confirm the message ---
  await page.evaluate((report) => {
    window.__test.nextReport = report;
  }, EMPTY_REPORT);
  await page.fill('#digest-date-input', '2026-08-27');
  await page.waitForTimeout(500);

  const bodyText1 = await page.locator('body').innerText();
  const hasEmptyMessage = bodyText1.includes('No emails in the archive for 2026-08-27');
  const hasNotFoundMessage = bodyText1.includes('No report found for');
  console.log('M4_EMPTY_INBOX_MESSAGE_SHOWN', hasEmptyMessage);
  console.log('M4_NOT_CONFUSED_WITH_NOT_FOUND', !hasNotFoundMessage);

  // --- M1: confirm a persisted cache entry now carries schemaVersion ---
  await page.fill('#digest-date-input', '2026-08-25'); // real 43-thread day, real fixture
  await page.waitForFunction(() => !document.body.innerText.includes('Fetching and parsing'), { timeout: 15000 });
  await page.waitForSelector('.digest-card', { timeout: 15000 });

  const storeAfterRealLoad = await page.evaluate(() => {
    const entry = window.__store.get('digest:2026-08-25');
    return entry ? { schemaVersion: entry.schemaVersion, threadCount: entry.threads.length } : null;
  });
  console.log('M1_CACHE_HAS_SCHEMA_VERSION', JSON.stringify(storeAfterRealLoad));

  // --- M1: inject an old/malformed-shape cache entry for a fresh date and
  // confirm it's treated as a cache miss (falls through to a real fetch)
  // rather than being loaded and risking a crash. ---
  await page.evaluate(() => {
    window.__store.set('digest:2026-08-24', { threads: [{ notTheRightShape: true }] }); // no schemaVersion at all — old-shape
  });
  const fetchCallsBefore = await page.evaluate(() => window.__test.fetchReportCalls);
  await page.fill('#digest-date-input', '2026-08-24');
  await page.waitForTimeout(500);
  const fetchCallsAfter = await page.evaluate(() => window.__test.fetchReportCalls);
  const bodyText2 = await page.locator('body').innerText();
  console.log('M1_OLD_SHAPE_CACHE_TREATED_AS_MISS', fetchCallsAfter > fetchCallsBefore);
  console.log('M1_NO_CRASH_ON_OLD_SHAPE_CACHE', !bodyText2.includes('Something went wrong'));

  console.log('\nPAGE_ERRORS:', pageErrors.length ? JSON.stringify(pageErrors) : '(none)');

  await browser.close();
})().catch((err) => { console.error('TEST_FAILED', err); process.exit(1); });
