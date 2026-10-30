import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4179');
  await page.getByRole('button', { name: 'Attention Is All You Need', exact: true }).waitFor();
  await page.screenshot({ path: 'test-output/ui-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Attention Is All You Need', exact: true }).click();
  await page.locator('#detail-dialog[open]').waitFor();
  await page.locator('[data-layer="outline"]').click();
  await page.locator('[data-section="s2"]').waitFor();
  await page.locator('#close-detail').click();
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#mineru-key').fill('fixture-not-a-real-secret');
  await page.getByRole('button', { name: '保存 / 替换', exact: true }).click();
  assert.equal(await page.locator('#mineru-key').inputValue(), '');
  await page.screenshot({ path: 'test-output/ui-settings.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-output/ui-mobile-settings.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator('[data-tab="library"]').click();
  await page.screenshot({ path: 'test-output/ui-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('UI desktop/mobile, detail layers and credential form checks passed.');
} finally { await browser.close(); }
