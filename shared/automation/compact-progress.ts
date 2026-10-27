type Fields = Record<string, unknown>;
const object = (v: unknown): Fields => v && typeof v === 'object' ? v as Fields : {};

/** Allowlisted progress only. Tool payloads remain inside the native process. */
export class CompactProgress {
  public static diagnostics(text: string): string {
    const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
    const selected = lines.filter(l => /^\s*ошибк/iu.test(l) || /^(?:\s*at\s|\s*(?:error|exception|assertionerror|typeerror|referenceerror|syntaxerror|rangeerror|expected|actual|npm (?:err|error))\b)|:\s*error\s+(?:TS\d+|[A-Z]+\d*)\b/i.test(l));
    return selected.slice(0, 16).map(l => l.slice(0, 700)).join('\n').slice(0, 4000) || 'Ошибка выполнения; подробности доступны у исполнителя.';
  }
  public static record(value: unknown): string[] {
    const event = object(value); const item = object(event.item); const type = String(event.type ?? '');
    if (type === 'item.completed') {
      if (item.type === 'command_execution' || typeof item.exit_code === 'number') {
        const code = typeof item.exit_code === 'number' ? item.exit_code : 'unknown';
        return [`Команда завершена: exit ${code}.`, ...(code !== 0 ? [this.diagnostics(String(item.stderr ?? item.aggregated_output ?? ''))] : [])];
      }
      if (item.type === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return changes.slice(0, 20).map(c => `Изменён файл: ${String(object(c).path ?? '').replace(/[\r\n]/g, '').slice(0, 240)}`);
      }
      if (item.type === 'mcp_tool_call') return ['Обращение к инструменту завершено.'];
      // agent_message, reasoning, patch bodies and MCP results are never progress text.
    }
    if (type === 'turn.completed' || type === 'result' || typeof event.verdict === 'string') return ['Ответ агента получен.'];
    const message = object(event.error).message ?? (type === 'error' ? event.message : undefined);
    if (typeof message === 'string') return [this.diagnostics(`Error: ${message}`)];
    return [];
  }
}
