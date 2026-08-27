const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  page.on('pageerror', (err) => logs.push('PAGEERROR: ' + err.message));

  await page.goto('http://127.0.0.1:8934/index.html');

  await page.fill('#digest-date-input', '2026-08-25');
  await page.waitForSelector('text=Contents', { timeout: 15000 });
  await page.waitForFunction(() => !document.body.innerText.includes('Fetching and parsing'), { timeout: 15000 });

  const summaryLinkCount = await page.locator('text=Read full email ↓').count();
  console.log('SUMMARY_CARD_COUNT', summaryLinkCount);
  const contentsItems = await page.locator('ol li').count();
  console.log('CONTENTS_ITEM_COUNT', contentsItems);

  // Cards (both summary + full-email) that mention the HVAC thread's subject.
  const hvacCards = page.locator('.digest-card').filter({ hasText: 'HVAC referral - lower Bucks' });
  const hvacCardCount = await hvacCards.count();
  console.log('HVAC_CARD_MATCHES', hvacCardCount); // expect 2: summary card + full-email card

  const hvacSummaryCard = hvacCards.nth(0);
  const hvacFullCard = hvacCards.nth(1);

  const summarySnippet = await hvacSummaryCard.innerText();
  console.log('HVAC_SUMMARY_CARD_SNIPPET', JSON.stringify(summarySnippet.slice(0, 250)));

  const fullSnippet = await hvacFullCard.innerText();
  const msgIdMatches = (fullSnippet.match(/Message ID:/g) || []).length;
  console.log('HVAC_FULL_EMAIL_MESSAGE_COUNT', msgIdMatches); // expect 6

  // --- JUMP DOWN: click "Read full email" inside the HVAC summary card ---
  await hvacSummaryCard.locator('text=Read full email ↓').click();
  await page.waitForTimeout(700);
  const box1 = await hvacFullCard.boundingBox();
  console.log('AFTER_JUMP_DOWN full-email card box', JSON.stringify(box1));
  console.log('JUMP_DOWN_LANDED_NEAR_TOP', box1 && box1.y >= -5 && box1.y < 300);

  // --- JUMP BACK: click "Back to summary" inside the HVAC full-email card ---
  await hvacFullCard.locator('text=Back to summary ↑').click();
  await page.waitForTimeout(700);
  const box2 = await hvacSummaryCard.boundingBox();
  console.log('AFTER_JUMP_BACK summary card box', JSON.stringify(box2));
  console.log('JUMP_BACK_LANDED_NEAR_TOP', box2 && box2.y >= -5 && box2.y < 300);

  // --- Contents -> Summaries jump ---
  await page.locator('ol li span.digest-link').first().click();
  await page.waitForTimeout(700);
  const box3 = await page.locator('.digest-card').first().boundingBox();
  console.log('CONTENTS_JUMP_LANDED_NEAR_TOP', box3 && box3.y >= -5 && box3.y < 300);

  // --- Verify starring an UNREAD thread does NOT exempt it from "Mark all read" ---
  const firstCard = page.locator('.digest-card').first(); // in Summaries section, still unread at this point
  const firstCardStarBtn = firstCard.locator('button[title="Star"], button[title="Unstar"]').first();
  await firstCardStarBtn.click();
  await page.waitForTimeout(200);
  const firstCardStarTitleAfterClick = await firstCardStarBtn.getAttribute('title');
  const firstCardClassBeforeMarkAll = await firstCard.getAttribute('class');
  console.log('STARRED_THREAD_BEFORE_MARK_ALL', JSON.stringify({ starTitle: firstCardStarTitleAfterClick, cardClass: firstCardClassBeforeMarkAll }));

  // --- Toggle read on HVAC card (optimistic UI) ---
  const dotBtn = hvacSummaryCard.locator('button[title="Mark read"], button[title="Mark unread"]').first();
  const titleBefore = await dotBtn.getAttribute('title');
  await dotBtn.click();
  await page.waitForTimeout(200);
  const classAfter = await hvacSummaryCard.getAttribute('class');
  console.log('TOGGLE_READ', JSON.stringify({ titleBefore, classAfter }));

  // --- Mark all read (must include the now-starred/unstarred HVAC thread too) ---
  // Star the HVAC thread first, then Mark all read, and confirm it still gets included.
  const starBtn = hvacSummaryCard.locator('button[title="Star"], button[title="Unstar"]').first();
  await starBtn.click();
  await page.waitForTimeout(200);

  const markAllBtn = page.locator('button', { hasText: 'Mark all read' });
  const markAllTextBefore = await markAllBtn.innerText();
  await markAllBtn.click();
  await page.waitForTimeout(600);
  const markAllTextAfter = await markAllBtn.innerText();
  console.log('MARK_ALL_READ', JSON.stringify({ before: markAllTextBefore, after: markAllTextAfter }));

  const firstCardClassAfterMarkAll = await firstCard.getAttribute('class');
  const firstCardStarTitleAfterMarkAll = await firstCardStarBtn.getAttribute('title');
  console.log('STARRED_THREAD_AFTER_MARK_ALL', JSON.stringify({ cardClass: firstCardClassAfterMarkAll, starTitle: firstCardStarTitleAfterMarkAll }));

  const testState = await page.evaluate(() => window.__test);
  console.log('TEST_STATE_AFTER_FIRST_LOAD', JSON.stringify({
    fetchReportCalls: testState.fetchReportCalls,
    summarizeCalls: testState.summarizeCalls,
    gmailActionCallCount: testState.gmailActionCalls.length,
    gmailActionKeys: testState.gmailActionCalls.map(c => c.actionKey),
    markAllReadIdCount: (testState.gmailActionCalls.find(c => c.actionKey === 'markRead' && c.messageIds.length > 6) || {}).messageIds?.length,
  }));

  const storeKeys = await page.evaluate(() => Array.from(window.__store.keys()));
  console.log('STORE_KEYS', storeKeys);

  // --- Second load of the SAME date: must not re-fetch / re-summarize ---
  await page.evaluate(() => { window.__test.fetchReportCalls = 0; window.__test.summarizeCalls = 0; });
  await page.fill('#digest-date-input', '2026-08-24'); // no report -> not-found state
  await page.waitForTimeout(400);
  const notFoundText = await page.locator('body').innerText();
  console.log('NOT_FOUND_SHOWN', notFoundText.includes('No report found for 2026-08-24'));

  await page.fill('#digest-date-input', '2026-08-25');
  await page.waitForTimeout(1000);
  const testState2 = await page.evaluate(() => window.__test);
  console.log('TEST_STATE_AFTER_SECOND_LOAD', JSON.stringify({
    fetchReportCalls: testState2.fetchReportCalls,
    summarizeCalls: testState2.summarizeCalls,
  }));

  // Confirm the HVAC thread's read/star state survived the reload from cache.
  const hvacCardsAfterReload = page.locator('.digest-card').filter({ hasText: 'HVAC referral - lower Bucks' });
  const classAfterReload = await hvacCardsAfterReload.nth(0).getAttribute('class');
  console.log('HVAC_CARD_CLASS_AFTER_RELOAD', classAfterReload);

  console.log('---console/page errors---');
  console.log(logs.filter(l => l.startsWith('PAGEERROR')).join('\n') || '(none)');

  // --- On-demand full-body load for a truncated message (section 8) ---
  const truncatedLink = page.locator('text=load full email').first();
  const truncatedCount = await page.locator('text=Body truncated at 5,000 characters').count();
  console.log('TRUNCATED_MESSAGE_COUNT', truncatedCount);
  if (truncatedCount > 0) {
    await truncatedLink.scrollIntoViewIfNeeded();
    const html = await truncatedLink.evaluate((el) => el.outerHTML);
    console.log('TRUNCATED_LINK_HTML', html);
    const parent = truncatedLink.locator('xpath=ancestor::div[contains(@class,"digest-card")]').first();
    await truncatedLink.click({ force: true });
    await page.waitForTimeout(50);
    const immediately = await parent.innerText();
    console.log('IMMEDIATELY_AFTER_CLICK_HAS_LOADING', immediately.includes('loading'));
    await page.waitForTimeout(1000);
    const parentTextAfter = await parent.innerText();
    console.log('FULL_PARENT_TEXT_AFTER', JSON.stringify(parentTextAfter));
    console.log('FULL_BODY_LOADED', parentTextAfter.includes('[test full body for'));
  }

  await browser.close();
})().catch((err) => { console.error('TEST_FAILED', err); process.exit(1); });
