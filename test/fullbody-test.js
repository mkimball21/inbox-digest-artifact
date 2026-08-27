const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('CONSOLE_ERROR:', msg.text()); });

  await page.goto('http://127.0.0.1:8934/index.html');
  await page.fill('#digest-date-input', '2026-08-25');
  await page.waitForFunction(() => !document.body.innerText.includes('Fetching and parsing'), { timeout: 15000 });
  await page.waitForSelector('text=load full email', { timeout: 15000 });

  const link = page.locator('text=load full email').first();
  const box = await link.boundingBox();
  console.log('LINK_BOX', box);
  await link.click();
  await page.waitForTimeout(600);
  const bodyText = await page.locator('body').innerText();
  console.log('HAS_TEST_FULL_BODY_TEXT', bodyText.includes('[test full body for'));
  console.log('HAS_TRUNCATED_AFFORDANCE_STILL', bodyText.includes('load full email'));

  await browser.close();
})().catch((err) => { console.error('TEST_FAILED', err); process.exit(1); });
