/** Keep successful test output out of agent history; preserve real failure details. */
export default async function* compactReporter(source) {
  let passed = 0; let failed = 0; let skipped = 0;
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === 'test:pass' && data.details?.type !== 'suite') {
      if (data.skip || data.todo) skipped++; else passed++;
    }
    if (event.type === 'test:fail' && data.details?.error?.failureType !== 'subtestsFailed') {
      failed++;
      const error = data.details?.error?.cause ?? data.details?.error;
      yield `❌ ${data.name}\n${String(error?.stack ?? error?.message ?? error ?? 'Test failed').slice(0, 6000)}\n`;
    }
  }
  yield failed ? `❌ ${failed} failed; ${passed} passed; ${skipped} skipped\n`
    : `✅ All ${passed} tests passed successfully${skipped ? ` (${skipped} skipped)` : ''}\n`;
}
