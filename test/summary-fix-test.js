const { chromium } = require('playwright');

async function runOne(page, url, label) {
  await page.goto(url);
  await page.fill('#digest-date-input', '2026-08-25');
  await page.waitForFunction(() => !document.body.innerText.includes('Fetching and parsing'), { timeout: 15000 });
  await page.waitForSelector('.digest-card', { timeout: 15000 });

  // Wait until every card has settled (no "Summarizing…" left), with a cap.
  const settled = await page.waitForFunction(
    () => !document.body.innerText.includes('Summarizing…'),
    { timeout: 60000 }
  ).then(() => true).catch(() => false);

  const totalCards = await page.locator('.digest-jumpbar').count() > 0
    ? await page.locator('section').first().locator('ol li').count()
    : 0;

  const doneCount = await page.locator('text=Summary failed to generate.').count();
  const failedCount = doneCount; // "Summary failed to generate." count = failures
  const skippedCount = await page.locator('text=No readable content').count();
  const stillPendingCount = await page.locator('text=Summarizing…').count();

  // Sample a couple of error detail lines (the mono text under a failed card), if any.
  const errorSamples = [];
  const failedLocator = page.locator('.digest-card', { hasText: 'Summary failed to generate.' });
  const failedTotal = await failedLocator.count();
  for (let i = 0; i < Math.min(3, failedTotal); i++) {
    const txt = await failedLocator.nth(i).innerText();
    const lines = txt.split('\n');
    errorSamples.push(lines.slice(-3).join(' | '));
  }

  console.log(`\n=== ${label} ===`);
  console.log('settled before timeout:', settled);
  console.log('total contents entries:', totalCards);
  console.log('failed ("Summary failed to generate."):', failedCount);
  console.log('skipped (low-text):', skippedCount);
  console.log('still "Summarizing…" at cutoff:', stillPendingCount);
  console.log('sample error detail lines:', JSON.stringify(errorSamples, null, 2));

  return { failedCount, skippedCount, stillPendingCount, totalCards };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  const pageBefore = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  pageBefore.on('pageerror', (err) => console.log('BEFORE PAGEERROR:', err.message));
  const before = await runOne(pageBefore, 'http://127.0.0.1:8934/index-summary-before.html', 'BEFORE FIX (original code, mock max_tokens truncation)');

  const pageAfter = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  pageAfter.on('pageerror', (err) => console.log('AFTER PAGEERROR:', err.message));
  const after = await runOne(pageAfter, 'http://127.0.0.1:8934/index-summary-after.html', 'AFTER FIX (adaptive batching + truncation-aware split)');

  console.log('\n=== SUMMARY ===');
  console.log(`BEFORE: ${before.failedCount} failed / 43 threads`);
  console.log(`AFTER:  ${after.failedCount} failed / 43 threads`);

  await browser.close();
})().catch((err) => { console.error('TEST_FAILED', err); process.exit(1); });
