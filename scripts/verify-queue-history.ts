import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';
import { checkFingerprint } from '../server/src/automation/check-evidence.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-history-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
  const task = app.taskService.createTask({ title: 'Accepted task with failed attempts' });
  const failed = service.enqueue(task.id); const owned = service.claim('fixture')!;
  service.fail(failed.id, owned.leaseToken!, 'fixture budget failure');
  app.taskService.setStatus({ id: task.id, status: 'review', actor: 'user' });
  const next = app.taskService.createTask({ title: 'Pending work' }); const pending = service.enqueue(next.id);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(18000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.locator('sat-sidebar button').filter({ hasText: 'Запуски агентов' }).click();
  const queue = page.locator('sat-automation-queue');
  await page.waitForURL('**/automation/runs/history');
  await queue.getByRole('button', { name: 'Рабочая очередь', exact: true }).click();
  const failedCard = queue.getByRole('button', { name: `Запуск ${task.id} ${failed.id}`, exact: true });
  await queue.getByRole('button', { name: `Запуск ${next.id} ${pending.id}`, exact: true }).waitFor();
  assert.equal(await failedCard.count(), 0, 'Terminal attempts must not remain in the working queue');
  await queue.getByRole('button', { name: 'История', exact: true }).click();
  await page.waitForURL('**/automation/runs/history');
  const collapse = queue.getByRole('button', { name: 'Свернуть список запусков' });
  const expand = queue.getByRole('button', { name: 'Развернуть список запусков' });
  const togglePosition = await collapse.boundingBox();
  await collapse.click();
  await expand.waitFor();
  assert.equal((await expand.boundingBox())?.x, togglePosition?.x);
  assert.equal((await expand.boundingBox())?.y, togglePosition?.y);
  const sidebarBounds = await queue.locator('.queue-sidebar').boundingBox();
  const runBounds = await queue.locator('.queue-main').boundingBox();
  assert.ok(runBounds && sidebarBounds && runBounds.x >= sidebarBounds.x + sidebarBounds.width - 1);
  await expand.click();
  await failedCard.waitFor();
  assert.equal(await queue.locator('.run-card').first().getAttribute('data-status'), 'failed');
  assert.ok((await failedCard.getAttribute('class'))?.includes('selected'), 'The failed run is selected without a status filter');
  const actions = queue.locator('.run-header-actions');
  await queue.getByRole('button', { name: 'Причина сбоя' }).waitFor();
  const originalActions = await actions.boundingBox();
  let pollError = true;
  await page.route('**/api/automation/history', route => pollError
    ? route.fulfill({ status: 503, json: { error: { message: 'History poll fixture' } } })
    : route.continue());
  const feedback = queue.getByText(/Нет связи с очередью: History poll fixture/);
  await feedback.waitFor();
  assert.deepEqual(await actions.boundingBox(), originalActions, 'A poll failure keeps launch controls in place');
  pollError = false;
  await page.unroute('**/api/automation/history');
  await failedCard.click();
  await page.waitForURL(url => url.searchParams.get('run') === failed.id);
  await page.reload();
  await queue.getByRole('heading', { name: task.title }).waitFor();
  await queue.getByRole('button', { name: 'Причина сбоя' }).click();
  await page.locator('.failure-content').getByText(/fixture budget failure/).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await queue.getByRole('button', { name: 'Продолжить с места остановки', exact: true }).count(), 0, 'Accepted tasks cannot resume');
  await queue.getByRole('button', { name: 'Подробности запуска', exact: true }).click();
  await queue.getByRole('button', { name: 'Очистить файлы', exact: true }).click();
  const confirmation = queue.getByRole('region', { name: 'Подтверждение действия' });
  assert.equal(await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).isEnabled(), false);
  await confirmation.locator('#discard-run').check();
  await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await queue.getByText(/ожидает host worker/).waitFor();
  const request = service.projects.poll('fixture-host')!;
  assert.equal(request.action, 'cleanup');
  service.completeHost(request.id, request.token!, { path: '/fixture', cleanup: { paths: [], branches: [], retainedBranches: [] } });
  await queue.getByText(/файлы очищены, история сохранена/).waitFor();
  await queue.getByRole('button', { name: 'Удалить запуск навсегда', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(service.detail(failed.id).run.id, failed.id, 'Cancellation keeps the journal');
  await queue.getByRole('button', { name: 'Удалить запуск навсегда', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click(); await failedCard.waitFor({ state: 'hidden' });
  assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await queue.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
  }

  // Real end-to-end metrics, out-of-page event inspector, criterion evidence and SAT-55 subtask flow (no mocked API)
  const screenshotsDir = path.resolve('.sat/screenshots');
  mkdirSync(screenshotsDir, { recursive: true });
  const wsId = 'simple-ai-tracker';
  app.workspaceManager.create(wsId, 'Simple AI Tracker');
  let failEventId = 0;
  let failRunId = '';
  let improvementTaskId = '';
  let passRunId = '';
  const sha = 'a'.repeat(40);
  app.workspaceManager.within(wsId, () => {
    const active = app.workspaceManager.active;
    active.db.prepare(`INSERT INTO tasks(id, seq, type, title, description, status, created_at, updated_at)
      VALUES ('SAT-55', 55, 'feature', 'Самоулучшение', 'Feature', 'backlog', ?, ?)`)
      .run([new Date().toISOString(), new Date().toISOString()]);
    const cfg = {
      ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', mergePolicy: 'manual' as const,
      connections: [{ id: 'n', label: 'Native', kind: 'native' as const, supportsImages: false }],
      agents: [
        { id: 'developer', role: 'developer' as const, runner: 'codex' as const, connectionId: 'n', model: 'fixture', instructions: '' },
        { id: 'tester', role: 'tester' as const, runner: 'codex' as const, connectionId: 'n', model: 'fixture', instructions: '' },
      ],
      pipeline: ['developer', 'tester'], checks: [{ command: 'npm', args: ['test'] }],
    };
    active.automationService.configure(cfg);
    const fp = checkFingerprint(cfg.checks);
    const metricTask = active.taskService.createTask({ title: 'Реальная проверка метрик' });
    active.taskService.attachPlan({ id: metricTask.id, planContent: '# План\n1. Проверить метрики.' });

    // Run 1: fails on mandatory check + >200 filler events so failure event is outside last 200
    const r1 = active.automationService.enqueue(metricTask.id);
    failRunId = r1.id;
    const c1 = active.automationService.claim('e2e-w1')!;
    active.automationService.beginStage(r1.id, c1.leaseToken!);
    active.automationService.completeStage(r1.id, c1.leaseToken!, { verdict: 'pass', summary: 'dev done' }, `sat/${r1.id}`, sha);
    active.automationService.beginStage(r1.id, c1.leaseToken!);
    const failCheckId = randomUUID();
    const failBase = { id: failCheckId, runId: r1.id, attempt: 1, stage: 1, phase: 'stage' as const, revision: 0, sha, fingerprint: fp, position: 0, command: 'npm', args: ['test'], at: new Date().toISOString() };
    active.automationService.checkExecution(r1.id, c1.leaseToken!, { ...failBase, outcome: { kind: 'unknown' } }, true);
    const failEvidence = active.automationService.checkExecution(r1.id, c1.leaseToken!, { ...failBase, outcome: { kind: 'exit', code: 1 } }, false) as { eventId: number };
    active.automationService.fail(r1.id, c1.leaseToken!, 'Mandatory npm test failed with exit 1');
    const runsRepo = active.automationService['runs'];
    const occ = runsRepo.latestOccurrence(r1.id)!;
    failEventId = occ.eventId;
    improvementTaskId = occ.improvementTaskId!;
    assert.ok(failEventId === failEvidence.eventId || failEventId > 0);
    assert.ok(improvementTaskId, 'First failure in simple-ai-tracker must create SAT-55 subtask');
    for (let i = 0; i < 210; i++) runsRepo.event(r1.id, 'note', `post-failure log ${i}`, new Date().toISOString());

    // Run 2: passes mandatory check with verifiable execution
    active.taskService.setStatus({ id: metricTask.id, status: 'ready', actor: 'user' });
    const r2 = active.automationService.enqueue(metricTask.id);
    passRunId = r2.id;
    const c2 = active.automationService.claim('e2e-w2')!;
    active.automationService.beginStage(r2.id, c2.leaseToken!);
    active.automationService.completeStage(r2.id, c2.leaseToken!, { verdict: 'pass', summary: 'dev fixed' }, `sat/${r2.id}`, sha);
    active.automationService.beginStage(r2.id, c2.leaseToken!);
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=', 'base64');
    const pngDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;
    const passCheckId = randomUUID();
    const passBase = { id: passCheckId, runId: r2.id, attempt: 1, stage: 1, phase: 'stage' as const, revision: 0, sha, fingerprint: fp, position: 0, command: 'npm', args: ['test'], at: new Date().toISOString() };
    active.automationService.checkExecution(r2.id, c2.leaseToken!, { ...passBase, outcome: { kind: 'unknown' } }, true);
    active.automationService.checkExecution(r2.id, c2.leaseToken!, { ...passBase, outcome: { kind: 'exit', code: 0 }, browserResults: [{ criterionId: 'AC-1', action: 'open metrics', assertion: 'ratio 1/2', actual: '1/2 shown', screenshot: '.sat/screenshots/check.png', imageDigest: createHash('sha256').update(pngDataUrl).digest('hex') }] }, false);
    active.automationService.completeStage(r2.id, c2.leaseToken!, { verdict: 'pass', summary: 'all checks passed' }, `sat/${r2.id}`, sha, undefined, false, [passCheckId], [pngDataUrl]);
  });

  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const activate = await page.request.post(`${baseUrl}/api/workspaces/${wsId}/activate`);
  assert.equal(activate.status(), 200);
  const metricsApiRes = await page.request.get(`${baseUrl}/api/automation/metrics?workspace=${wsId}`);
  assert.equal(metricsApiRes.status(), 200);
  const metricsApi = await metricsApiRes.json() as { runs: number; tasks: number; technical: { numerator: number; denominator: number }; acceptance: { numerator: number; denominator: number } };
  assert.deepEqual(metricsApi.technical, { numerator: 1, denominator: 2 }, `Real metrics API mismatch: ${JSON.stringify(metricsApi)}`);
  assert.deepEqual(metricsApi.acceptance, { numerator: 0, denominator: 1 }, `Real acceptance API mismatch: ${JSON.stringify(metricsApi)}`);
  await page.evaluate(ws => sessionStorage.setItem('sat.workspace', ws), wsId);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl);
  await page.locator('sat-sidebar button').filter({ hasText: 'Запуски агентов' }).click();
  await queue.getByRole('button', { name: 'Метрики', exact: true }).click();
  const metrics = queue.locator('sat-automation-metrics');
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  await metrics.getByText('0 / 1', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshotsDir, 'metrics-dashboard-desktop.png') });

  // Change period via real click on Применить
  await metrics.getByRole('button', { name: 'Применить', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();

  // Open out-of-page failure event in inspector
  await metrics.getByRole('button', { name: new RegExp(`Открыть событие ${failEventId}`) }).click();
  await queue.locator('#evidence-heading').waitFor();
  assert.ok((await queue.textContent())?.includes(`${failEventId}`), 'Inspector must display exact out-of-page event ID');
  await page.screenshot({ path: path.join(screenshotsDir, 'metrics-inspector-desktop.png') });

  // Narrow viewport checks and screenshots
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await queue.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Inspector must not overflow on 390px');
  await page.screenshot({ path: path.join(screenshotsDir, 'metrics-inspector-mobile.png') });
  await queue.getByRole('button', { name: 'К метрикам', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  assert.ok(await queue.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Dashboard must not overflow on 390px');
  await page.screenshot({ path: path.join(screenshotsDir, 'metrics-dashboard-mobile.png') });

  // Open linked SAT-55 subtask and verify card opens
  await page.setViewportSize({ width: 1440, height: 1000 });
  await metrics.getByRole('button', { name: `Открыть подзадачу ${improvementTaskId}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Карточка задачи' }).getByText(improvementTaskId, { exact: true }).waitFor();

  const external = await browser.newPage();
  await external.goto(`${baseUrl}/?workspace=${wsId}&automationRun=${failRunId}&eventId=${failEventId}`);
  await external.waitForURL(url => url.pathname === '/automation/runs/history' && url.searchParams.get('run') === failRunId);
  await external.locator('.selected-evidence').getByRole('heading', { name: new RegExp(String(failEventId)) }).waitFor();
  await external.close();

  // Verify passing run detail endpoint returns verifiable check evidence
  const passDetailRes = await page.request.get(`${baseUrl}/api/automation/runs/${passRunId}?workspace=${wsId}`);
  assert.equal(passDetailRes.status(), 200);
  const passDetail = await passDetailRes.json() as { checks?: { sha: string; attempt: number }[] };
  assert.equal(passDetail.checks?.length, 1);
  assert.equal(passDetail.checks?.[0].sha, sha);

  await page.goto(`${baseUrl}/automation/runs/history?workspace=${wsId}&run=${passRunId}`);
  await queue.getByRole('button', { name: 'Действия с запуском' }).click();
  const diffRequest = page.waitForResponse(response => response.url().endsWith(`/runs/${passRunId}/diff`));
  await page.getByRole('button', { name: 'Diff последнего коммита' }).click();
  await page.waitForURL(url => url.searchParams.get('panel') === 'commit-diff');
  assert.equal((await diffRequest).status(), 201);
  app.workspaceManager.within(wsId, () => {
    const automation = app.workspaceManager.active.automationService;
    const request = automation.projects.poll('diff-fixture')!;
    assert.equal(request.action, 'diff');
    automation.completeHost(request.id, request.token!, {
      path: '/fixture', diff: { text: 'diff --git a/item.txt b/item.txt\n@@ -1 +1 @@\n-old\n+new', truncated: false },
    });
  });
  await queue.getByRole('region', { name: /Содержимое Git Diff|Изменения по строкам/ }).getByText('new', { exact: true }).waitFor();
  await page.goBack();
  await queue.getByRole('heading', { name: 'Изменения последнего коммита' }).waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.get('run'), passRunId);

  assert.deepEqual(errors, []);
  console.log('PASS: active queue, task history, real metrics/detail E2E, out-of-page inspector, SAT-55 subtask navigation, responsive screenshots. No models or real task store used.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true });
}
