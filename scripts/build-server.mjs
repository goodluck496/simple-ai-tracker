import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// AGENT_INSTRUCTIONS.md вшивается в MCP-сервер как текст: инструкция всегда
// доступна агенту через инструмент tracker_get_instructions и как server.instructions.
const instructionsPath = path.join(ROOT, 'AGENT_INSTRUCTIONS.md');
if (!fs.existsSync(instructionsPath)) {
  throw new Error(`Не найден файл инструкции: ${instructionsPath}`);
}

await build({
  entryPoints: {
    api: path.join(ROOT, 'server/src/bootstrap/api-entry.ts'),
    mcp: path.join(ROOT, 'server/src/bootstrap/mcp-entry.ts'),
    cli: path.join(ROOT, 'server/src/bootstrap/cli-entry.ts'),
    worker: path.join(ROOT, 'server/src/bootstrap/worker-entry.ts'),
  },
  outdir: path.join(ROOT, 'dist/server'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['@modelcontextprotocol/sdk', 'cross-spawn'],
  loader: { '.md': 'text' },
  tsconfig: path.join(ROOT, 'tsconfig.server.json'),
  logLevel: 'info',
});

// One portable host file, without node_modules or the tracker checkout.
await build({
  entryPoints: [path.join(ROOT, 'server/src/bootstrap/portable-worker-entry.ts')],
  outfile: path.join(ROOT, 'dist/server/worker-host.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  tsconfig: path.join(ROOT, 'tsconfig.server.json'), logLevel: 'info',
});

// stdout может быть занят протоколом MCP (при сборке из mcp-launcher.mjs),
// поэтому итоговое сообщение пишем в stderr.
process.stderr.write('[simple-ai-tracker] Server bundles built into dist/server\n');
