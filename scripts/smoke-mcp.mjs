import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

/**
 * Дымовой тест MCP-сервера: проверяет, что клиент видит инструменты,
 * получает инструкции и что базовые чтения работают.
 * Запуск: `npm run smoke:mcp -- [TASK_ID]` (по умолчанию берётся первая задача).
 * Только чтение — база не изменяется.
 */
const appRoot = path.resolve(import.meta.dirname, '..');
const mcpEntry = path.join(appRoot, 'dist', 'server', 'mcp.mjs');

const client = new Client({ name: 'sat-smoke', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    cwd: appRoot,
    stderr: 'inherit',
  }),
);

const textOf = (result) => {
  const [first] = result.content ?? [];
  if (!first || first.type !== 'text') throw new Error('Ожидался текстовый ответ MCP');
  return first.text;
};

const tools = await client.listTools();
const instructions = client.getInstructions() ?? '';

const listed = JSON.parse(textOf(await client.callTool({ name: 'tracker_list_tasks', arguments: { limit: 5 } })));
const requestedId = process.argv[2];
const taskId = requestedId ?? listed[0]?.id;

let taskCheck = 'пропущено (в базе нет задач)';
if (taskId) {
  const task = JSON.parse(textOf(await client.callTool({ name: 'tracker_get_task', arguments: { id: taskId } })));
  const verify = JSON.parse(textOf(await client.callTool({ name: 'tracker_verify_task', arguments: { id: taskId } })));
  taskCheck = `${task.id} «${task.title.slice(0, 40)}» статус=${task.status} план=${task.plan ? `v${task.plan.version}` : 'нет'} ` +
    `вопросов=${task.questions.open.length} журнал=${task.decisionLog.length} верификация=${verify.valid ? 'ok' : 'ошибки'}`;
}

console.log(
  JSON.stringify(
    {
      mcpEntry,
      tools: tools.tools.length,
      instructionsChars: instructions.length,
      instructionsHaveNoGrepRule: /grep/i.test(instructions),
      listedTasks: listed.length,
      taskCheck,
    },
    null,
    2,
  ),
);

await client.close();
