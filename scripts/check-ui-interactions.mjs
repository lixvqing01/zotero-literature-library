import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { ...descriptor, set(value) {
      if (this.classList.contains('list-pagination')) throw Error('Privileged host strips innerHTML pagination controls');
      descriptor.set.call(this, value);
    } });
  });
  await page.route('**/preview-data.json', async route => {
    const response = await route.fetch(); const fixture = await response.json();
    for (let i = 0; i < 120; i++) fixture.documents.push({ ...fixture.documents[0], id: `extra-${i}`, title: `Indexed paper ${i}` });
    fixture.status.queue.push(
      { id: 'no-pdf', documentID: 'absent', documentTitle: 'No PDF fixture', state: 'failed', error: { code: 'PDF_MISSING', message: 'PDF 尚未下载' } },
      { id: 'pages', documentID: 'too-long', documentTitle: 'Page limit fixture', state: 'failed', error: { code: 'MINERU_PAGE_LIMIT', message: 'PDF 页数超出限制' } },
      { id: 'finished', documentID: 'complete', state: 'done' }
    );
    for (let i = 0; i < 70; i++) fixture.status.queue.push({ id: `running-${i}`, documentID: `remote-${i}`, documentTitle: `Processing paper ${i}`, state: 'running' });
    await route.fulfill({ json: fixture });
  });
  await page.goto('http://127.0.0.1:4179');
  await page.locator('#page-next').waitFor();
  assert.equal(await page.locator('#document-rows tr').count(), 50);
  await page.locator('#page-next').click();
  assert.equal(await page.locator('.list-pagination span').textContent(), '2 / 3 · 123 篇');
  await page.locator('#page-next').click();
  assert.equal(await page.locator('#document-rows tr').count(), 23);
  await page.locator('#page-previous').click();
  await page.locator('#library-sort').selectOption('publication');
  assert.match(await page.locator('#document-rows tr:first-child').innerText(), /Qwen3 Embedding/);
  await page.locator('#library-sort').selectOption('title');
  assert.match(await page.locator('#document-rows tr:first-child').innerText(), /Attention Is All You Need/);
  await page.locator('#library-sort-direction').click();
  assert.doesNotMatch(await page.locator('#document-rows tr:first-child').innerText(), /Attention Is All You Need/);
  await page.locator('#library-sort-direction').click();

  await page.locator('#search-query').click();
  await page.locator('#search-query').pressSequentially('Attention', { delay: 30 });
  await page.evaluate(() => { window.savedSearchInput = document.getElementById('search-query'); });
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.dispatchEvent(new Event('literature-library-change')));
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.activeElement === window.savedSearchInput && window.savedSearchInput === document.getElementById('search-query')), true);
  }
  await page.locator('#search-query').press('Enter');
  await page.locator('#search-notice').filter({ hasText: '1 个结果' }).waitFor();
  assert.equal(await page.locator('#document-rows tr').count(), 1);
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#search-query').inputValue(), '');
  assert.equal(await page.locator('#document-rows tr').count(), 50);
  await page.locator('#search-query').fill('No matching paper');
  await page.locator('button[type=submit][title="搜索"]').click();
  await page.locator('#search-notice').filter({ hasText: '0 个结果' }).waitFor();
  await page.locator('#clear-search').click();
  await page.screenshot({ path: 'test-output/ui-library-large.png', fullPage: false });

  await page.locator('[data-tab="jobs"]').click();
  assert.equal(await page.locator('#view tbody tr').count(), 50);
  await page.locator('#jobs-next').click();
  assert.equal(await page.locator('#view tbody tr').count(), 26);
  await page.locator('[data-job-filter="attention"]').click();
  await page.getByText('Page limit fixture', { exact: true }).waitFor();
  await page.getByText('No PDF fixture', { exact: true }).waitFor();
  await page.locator('#job-search-query').fill('Page limit');
  await page.locator('#job-search-form').evaluate(form => form.requestSubmit());
  assert.equal(await page.locator('#view tbody tr').count(), 1);
  await page.getByText('Page limit fixture', { exact: true }).waitFor();
  await page.locator('#clear-job-search').click();
  assert.equal(await page.locator('#view tbody tr').count(), 5);
  await page.locator('[data-job-filter="retryable"]').click();
  assert.equal(await page.locator('#view tbody tr').count(), 2);
  assert.equal(await page.getByText('No PDF fixture', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Page limit fixture', { exact: true }).count(), 0);
  await page.locator('#resume-jobs').click();
  await page.locator('#notification').filter({ hasText: '已恢复 2 项，跳过 2 项' }).waitFor();
  assert.equal(await page.locator('#resume-jobs').isDisabled(), true);
  await page.locator('[data-job-filter="attention"]').click();
  await page.getByText('Page limit fixture', { exact: true }).waitFor();
  await page.getByText('No PDF fixture', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-output/ui-queue-filtered.png', fullPage: true });
  await page.locator('[data-job-filter="attention"]').click();
  await page.locator('#select-all-jobs').check();
  assert.equal(await page.locator('#retry-selected').isDisabled(), true);
  assert.equal(await page.locator('#delete-selected').isEnabled(), true);
  await page.locator('[data-job-id="j3"]').click({ button: 'right' });
  await page.locator('#task-context-menu').waitFor({ state: 'visible' });
  await page.locator('#task-context-rebuild').click();
  await page.locator('#notification').filter({ hasText: '已加入重建队列' }).waitFor();
  await page.locator('#delete-selected').click();
  await page.locator('#notification').filter({ hasText: '已删除 3 项' }).waitFor();
  assert.equal(await page.locator('[data-job-filter="attention"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-job-filter="completed"]').click();
  await page.locator('#clear-completed').click();
  await page.locator('#notification').filter({ hasText: '已清理 1 个已完成任务' }).waitFor();
  assert.equal(await page.locator('[data-job-id="finished"]').count(), 0);
  for (const width of [960, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('[data-tab="library"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `test-output/ui-library-${width}.png`, fullPage: false });
    const input = await page.locator('#search-query').boundingBox();
    const submit = await page.locator('button[type=submit][title="搜索"]').boundingBox();
    assert(input.width > 100 && submit.width > 35);
    assert((await page.locator('#search-layer').boundingBox()).width >= 90);
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#notification.error').count(), 0);
  const xmlPage = await browser.newPage();
  xmlPage.on('pageerror', error => errors.push(error.message));
  await xmlPage.route('http://127.0.0.1:4179/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, contentType: 'application/xhtml+xml' });
  });
  await xmlPage.route('**/preview-data.json', async route => {
    const response = await route.fetch(); const fixture = await response.json();
    for (let i = 0; i < 65; i++) fixture.documents.push({ ...fixture.documents[0], id: `xml-${i}`, title: `XHTML paper ${i}` });
    await route.fulfill({ json: fixture });
  });
  await xmlPage.goto('http://127.0.0.1:4179/');
  await xmlPage.locator('#page-next').waitFor();
  assert.equal(await xmlPage.evaluate(() => document.contentType), 'application/xhtml+xml');
  await xmlPage.locator('#page-next').click();
  assert.equal(await xmlPage.locator('#document-rows tr').count(), 18);
  await xmlPage.locator('#search-query').fill('Attention');
  await xmlPage.locator('#search-query').press('Enter');
  await xmlPage.locator('#search-notice').filter({ hasText: '1 个结果' }).waitFor();
  assert.equal(await xmlPage.locator('#notification.error').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Large library/queue pagination, privileged controls, focus during updates, search/clear/Enter, bulk retry exclusions and responsive layout passed.');
} finally { await browser.close(); }
