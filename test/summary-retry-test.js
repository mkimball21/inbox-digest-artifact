const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

  await page.goto('http://127.0.0.1:8934/index-summary-retry.html');
  await page.fill('#digest-date-input', '2026-08-25');
  await page.waitForFunction(() => !document.body.innerText.includes('Fetching and parsing'), { timeout: 15000 });
  await page.waitForFunction(() => !document.body.innerText.includes('Summarizing…'), { timeout: 60000 });

  const failedCount = await page.locator('text=Summary failed to generate.').count();
  const skippedCount = await page.locator('text=No readable content').count();
  const mockStats = await page.evaluate(() => ({
    totalCalls: window.__mockCallCount,
    injectedErrors: window.__mockTransientErrorCount,
  }));

  console.log('RESULT', JSON.stringify({ failedCount, skippedCount, ...mockStats }));
  console.log(failedCount === 0
    ? `PASS: 0 failures despite ${mockStats.injectedErrors} injected transient 429/529 errors across ${mockStats.totalCalls} total fetch attempts (retries absorbed them)`
    : `FAIL: ${failedCount} threads still failed despite retry logic`);

  await browser.close();
})().catch((err) => { console.error('TEST_FAILED', err); process.exit(1); });
