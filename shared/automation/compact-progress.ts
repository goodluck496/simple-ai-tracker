type Fields = Record<string, unknown>;
const object = (v: unknown): Fields => v && typeof v === 'object' ? v as Fields : {};

/** Allowlisted progress only. Tool payloads remain inside the native process. */
export class CompactProgress {
  public static apiTool(name: string, args: Fields): string {
    const safe = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : '';
    const file = safe(args.path) || '.';
    const line = (value: unknown) => Number.isSafeInteger(value) ? String(value) : '?';
    switch (name) {
      case 'read_file': return `read_file ${file}:${line(args.startLine ?? 1)}–${line(args.endLine ?? Number(args.startLine ?? 1) + 39)}`;
      case 'list_files': case 'write_file': case 'edit_file': case 'inspect_changes': return `${name} ${file}`;
      case 'explore_code': return `${name} ${safe(args.symbol)}`;
      case 'run_check': return `${name} #${line(args.index)}`;
      case 'call_project_tool': return `${name} ${safe(args.server)}/${safe(args.tool)}`;
      default: return name.replace(/[^\w-]/g, '').slice(0, 80);
    }
  }
  /** Bounded operational status, never arbitrary stdout/source/tool payloads. */
  public static liveOutput(text: string): string {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
      .filter(line => /^\s*(?:npm (?:http|timing|warn|error|err)\b|(?:added|removed|changed|audited) \d+ packages?\b)/i.test(line))
      .slice(-3).map(line => line.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[скрыто]@')
        .replace(/([?&](?:token|key|api_key|password|secret)=)[^&\s]+/gi, '$1[скрыто]').slice(0, 300)).join('\n');
  }
  /** Command metadata only: never echo inline programs, patches or shell bodies. */
  public static command(command: string, args: readonly string[] = []): string {
    const raw = [command, ...args].join(' ').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const shell = raw.match(/(?:^|\s)-(?:Command|c)\s+["']?([\s\S]*)/i);
    let text = /(?:powershell|pwsh)(?:\.exe)?["']?\s/i.test(raw) && shell
      ? shell[1].replace(/["']$/, '').trim() : raw;
    const executable = text.match(/^"?([^"\s]+)"?/)?.[1]?.split(/[\\/]/).pop() ?? 'команда';
    if (/^(?:codex|claude|dsh|agy)(?:\.exe|\.cmd)?$/i.test(executable)) return `${executable}: запуск агента`;
    if (text.length > 320 || /[\r\n;|<>`]|\$\(|(?:^|\s)(?:-e|-c|--eval|-Command)(?:\s|=)|(?:apply_patch|Set-Content|WriteAllText|writeFile|echo|printf)(?:\s|\()/i.test(text)) {
      const actions = [...new Set(text.match(/\b(?:Get-Content|Select-Object|Select-String|rg|git|npm(?:\.cmd)?|npx(?:\.cmd)?|codegraph|apply_patch)\b/gi) ?? [])].slice(0, 5);
      return `${actions.length ? actions.join(', ') : executable}: сценарий (текст скрыт)`;
    }
    // Prevent flag values commonly used for credentials from entering progress.
    text = text.replace(/((?:--?|\/)(?:token|password|secret|api[-_]?key)(?:=|\s+))\S+/gi, '$1[скрыто]');
    return text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 320);
  }
  public static diagnostics(text: string): string {
    const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
    const selected = lines.filter(l => /^\s*ошибк/iu.test(l) || /^(?:\s*at\s|\s*(?:error|exception|assertionerror|typeerror|referenceerror|syntaxerror|rangeerror|expected|actual|npm (?:err|error))\b)|:\s*error\s+(?:TS\d+|[A-Z]+\d*)\b/i.test(l));
    return selected.slice(0, 16).map(l => l.slice(0, 700)).join('\n').slice(0, 4000) || 'Ошибка выполнения; подробности доступны у исполнителя.';
  }
  public static success(text: string): string[] {
    const tests = text.match(/(?:^|\n)\s*✅ All (\d+) tests passed successfully(?:\r?\n|$)/);
    return tests ? [`Тесты: ${tests[1]} пройдено.`] : [];
  }
  public static record(value: unknown): string[] {
    const event = object(value); const item = object(event.item); const type = String(event.type ?? '');
    if (type === 'item.started' && item.type === 'command_execution' && typeof item.command === 'string') return [`Выполняется: ${this.command(item.command)}`];
    if ((type === 'item.started' || type === 'item.completed') && item.type === 'mcp_tool_call') {
      const name = [item.server, item.tool].filter(v => typeof v === 'string').map(v => String(v).replace(/[^\w.-]/g, '').slice(0, 100)).join('/');
      const status = type === 'item.started' ? 'вызов' : item.status === 'failed' || item.error ? 'ошибка' : 'завершён';
      return [`MCP ${name || 'инструмент'}: ${status}.`];
    }
    if (type === 'item.completed') {
      if (item.type === 'command_execution' || typeof item.exit_code === 'number') {
        const code = typeof item.exit_code === 'number' ? item.exit_code : 'unknown';
        const label = typeof item.command === 'string' ? `Команда: ${this.command(item.command)} → exit ${code}.` : `Команда завершена: exit ${code}.`;
        return [label, ...(code !== 0 ? [this.diagnostics(String(item.stderr ?? item.aggregated_output ?? ''))] : this.success(String(item.aggregated_output ?? '')))];
      }
      if (item.type === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return changes.slice(0, 20).map(c => `Изменён файл: ${String(object(c).path ?? '').replace(/[\r\n]/g, '').slice(0, 240)}`);
      }
      // agent_message, reasoning, patch bodies and MCP results are never progress text.
    }
    if (type === 'turn.completed' || type === 'result' || typeof event.verdict === 'string') return ['Ответ агента получен.'];
    const message = object(event.error).message ?? (type === 'error' ? event.message : undefined);
    if (typeof message === 'string') return [this.diagnostics(`Error: ${message}`)];
    return [];
  }
}
