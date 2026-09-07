// Run against the isolated fixture server on 3013. Requires Playwright locally.
const { chromium } = require(process.env.SNSTICK_PLAYWRIGHT || 'playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) console.log('Fixture missing:', new URL(r.url()).pathname, r.status()); });
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3013' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:3013/qa/strategy-page.html');
    await page.locator('.sn-strategy-card').first().waitFor();
    assert.equal(await page.locator('.sn-strategy-card').count(), 8);
    await page.locator('.sn-strategy-card').nth(4).locator('button').first().click();
    await page.locator('.sn-strategy-focus').waitFor();
    await page.getByText('示例标的甲', { exact: true }).waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sn-screener-results > div')).opacity === '1');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sn-strategy-card')).opacity === '1');
    await page.screenshot({ path: path.resolve('../docs/design/strategy-page-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '浅色主题', exact: true }).click();
    await page.waitForTimeout(350); // Allow existing theme transitions to finish for visual capture.
    await page.screenshot({ path: path.resolve('../docs/design/strategy-page-light.png'), fullPage: true });
    await page.getByRole('button', { name: '深色主题', exact: true }).click();
    await page.waitForTimeout(350);
    await page.getByRole('button', { name: '参数设置', exact: true }).click();
    await page.locator('#strategy-settings-title').waitFor();
    await page.locator('.sn-dialog input[type="text"]').first().waitFor();
    assert.equal(await page.locator('.sn-dialog input[type="text"]').first().inputValue(), '放量突破');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve('../docs/design/strategy-page-mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page must not overflow viewport');
    await page.getByRole('button', { name: '紧凑', exact: true }).click();
    assert.equal(await page.locator('.sn-strategy-gallery').getAttribute('data-density'), 'mini');
    await page.getByRole('button', { name: '隐藏', exact: true }).click();
    assert.equal(await page.locator('.sn-strategy-gallery').count(), 0);
    await page.getByRole('button', { name: '标准', exact: true }).click();
    await page.getByRole('button', { name: '分钟', exact: true }).click();
    assert.equal(await page.locator('.sn-strategy-card').count(), 1);
    await page.getByRole('button', { name: '日线', exact: true }).click();
    assert.equal(await page.locator('.sn-strategy-card').count(), 7);
    assert.deepEqual(errors, []);
    console.log('PASS: real Screener render, selection/result, themes, 390px overflow, density and timeframe filters; zero page errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
