import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// In-memory host bridge: no Zotero process, user library, or cloud requests.
const fixture = await (await fetch('http://127.0.0.1:4179/preview-data.json')).json();
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(({ fixture }) => {
    let revision = 0;
    const queue = Array.from({ length: 55 }, (_, i) => ({ id: `task-${i}`, documentID: `paper-${i}`, documentTitle: `Queue paper ${i}`, state: 'failed',
      error: { code: 'MINERU_NETWORK_ERROR', message: '连接暂时失败' }, can_resume: true, can_bulk_resume: true }));
    queue.push(
      { id: 'blocked', documentID: 'd1', documentTitle: 'Blocked model', state: 'blocked_model', error: { message: '等待模型配置' }, can_resume: true, can_bulk_resume: true },
      { id: 'missing', documentID: 'missing', documentTitle: 'Missing PDF', state: 'failed', error: { message: '没有 PDF' }, retry_exclusion: '请补齐 PDF', can_resume: true, can_bulk_resume: false },
      { id: 'working', documentID: 'working', documentTitle: 'Running task', state: 'running', can_resume: false, can_bulk_resume: false }
    );
    fixture.status.queue = queue;
    const calls = { resumed: [], deleted: [], reindexed: [] };
    window.queueTestCalls = calls;
    window.arguments = [{ library: {
      status: async () => {
        revision++;
        return structuredClone({ ...fixture.status, queue: queue.map(job => ({ ...job, progress: job.id === 'working' ? { message: `Progress ${revision}` } : undefined })) });
      },
      list: async () => structuredClone(fixture.documents.filter(doc => doc.indexedAt)),
      resume: async (_reason, ids) => {
        await new Promise(resolve => setTimeout(resolve, 600));
        const targets = Array.isArray(ids) ? ids : [ids]; calls.resumed.push(targets);
        for (const job of queue) if (targets.includes(job.id) && job.can_bulk_resume) {
          job.state = 'queued'; job.error = undefined; job.can_resume = job.can_bulk_resume = false;
        }
        return { resumed: targets.length, skipped: 0 };
      },
      deleteJobs: async ids => {
        calls.deleted.push(ids);
        for (let i = queue.length - 1; i >= 0; i--) if (ids.includes(queue[i].id)) queue.splice(i, 1);
        return { deleted: ids.length, skipped: 0 };
      },
      search: async () => ({ mode: 'semantic', results: [{ document_id: 'd1' }, { document_id: 'd2' }] })
    } }];
  }, { fixture });
  await page.goto('http://127.0.0.1:4179/');
  // Server relevance order differs from alphabetical order and must remain intact.
  await page.locator('#search-query').fill('evidence');
  await page.locator('#search-query').press('Enter');
  await page.locator('#search-notice').filter({ hasText: '2 个结果' }).waitFor();
  assert.match(await page.locator('#document-rows tr:first-child').innerText(), /Retrieval-Augmented/);
  assert.equal(await page.locator('#library-sort').inputValue(), 'relevance');
  await page.locator('#library-sort').selectOption('title');
  assert.match(await page.locator('#document-rows tr:first-child').innerText(), /Attention Is All You Need/);
  await page.locator('[data-tab="jobs"]').click();
  await page.locator('[data-task-check="task-1"]').click();
  await page.locator('[data-task-check="task-4"]').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.task-check:checked').count(), 4);
  await page.locator('[data-task-check="task-2"]').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.task-check:checked').count(), 1);
  await page.locator('#clear-task-selection').click();
  await page.locator('[data-task-check="task-48"]').click();
  await page.locator('#jobs-next').click();
  await page.locator('[data-task-check="task-52"]').click({ modifiers: ['Shift'] });
  assert.match(await page.locator('#clear-task-selection').innerText(), /\(5\)/);
  await page.locator('#jobs-previous').click();
  assert.equal(await page.locator('.task-check:checked').count(), 2);
  await page.locator('#clear-task-selection').click();

  // Force actual queue progress updates while typing, not just unchanged refreshes.
  await page.locator('#job-search-query').fill('连接');
  await page.evaluate(() => { window.savedQueueSearch = document.getElementById('job-search-query'); });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.dispatchEvent(new Event('literature-library-change')));
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => document.activeElement === window.savedQueueSearch && window.savedQueueSearch === document.getElementById('job-search-query')), true);
  }
  assert.equal(await page.locator('#job-search-query').inputValue(), '连接');
  await page.locator('#job-search-query').press('Enter');
  assert.equal(await page.locator('#view tbody tr').count(), 50);
  await page.locator('#clear-job-search').click();

  await page.locator('[data-job-id="task-0"] td:nth-child(2)').click();
  await page.locator('[data-job-id="task-2"] td:nth-child(2)').click({ modifiers: ['Control'] });
  assert.equal(await page.locator('.task-check:checked').count(), 2);
  await page.locator('[data-job-id="task-2"]').click({ button: 'right' });
  assert.equal(await page.locator('#task-context-menu').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#task-context-menu').isVisible(), false);
  await page.locator('[data-job-id="task-2"]').click({ button: 'right' });
  await page.locator('#task-context-retry').click();
  assert.equal(await page.locator('#retry-selected').isDisabled(), true);
  await page.locator('[data-job-id="task-1"]').click({ button: 'right' });
  assert.equal(await page.locator('#task-context-retry').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('#notification').filter({ hasText: '已重试 2 项' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.queueTestCalls.resumed), [['task-0', 'task-2']]);

  await page.locator('#job-search-query').fill('Missing PDF');
  await page.locator('#job-search-query').press('Enter');
  await page.locator('#select-all-jobs').check();
  assert.equal(await page.locator('#retry-selected').isDisabled(), true);
  await page.locator('#delete-selected').click();
  await page.locator('#notification').filter({ hasText: '已删除 1 项' }).waitFor();
  assert.equal(await page.locator('[data-job-id="missing"]').count(), 0);
  await page.locator('#clear-job-search').click();
  await page.locator('#job-search-query').fill('Blocked model');
  await page.locator('#job-search-query').press('Enter');
  await page.locator('[data-delete-job="blocked"]').click();
  await page.locator('#notification').filter({ hasText: '已删除 1 项' }).waitFor();
  await page.locator('[data-tab="library"]').click();
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('tr[data-id="d1"]').count(), 1, 'Removing a blocked update must keep the existing indexed paper');
  await page.locator('[data-tab="jobs"]').click();
  await page.locator('#clear-job-search').click();
  await page.locator('#job-search-query').fill('Running task');
  await page.locator('#job-search-query').press('Enter');
  await page.locator('[data-job-id="working"]').click({ button: 'right' });
  assert.equal(await page.locator('#task-context-delete').isDisabled(), true);
  await page.locator('[data-tab="library"]').click();
  assert.equal(await page.locator('#task-context-menu').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Queue Shift/Ctrl selection across pages, changing progress focus, search, scoped retry/delete, protected running jobs, retained indexed papers and relevance sorting passed.');
} finally { await browser.close(); }
