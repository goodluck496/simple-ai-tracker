import { AGENT_VERDICTS, type AgentOutcome } from '../../../../shared/automation/contracts.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';

/** CLI success is not a task verdict. Never turn empty/denied output into pass. */
export class AntigravityResult {
  public static parse(raw: string, stderr: string, progress: (line: string) => void): { text: string; sessionId?: string } {
    let envelope: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      envelope = value as Record<string, unknown>;
    } catch { throw new Error('Antigravity вернул некорректную JSON-обёртку. Проверьте --output-format json и версию CLI.'); }
    const response = typeof envelope.response === 'string' ? envelope.response : '';
    const sessionId = typeof envelope.conversation_id === 'string' ? envelope.conversation_id : undefined;
    const hasStructured = envelope.structured_output !== undefined && envelope.structured_output !== null;
    const status = typeof envelope.status === 'string' ? envelope.status.replace(/[^A-Za-z_]/g, '').slice(0, 30) : 'missing';
    progress(`Antigravity CLI: status=${status}; structured_output=${hasStructured ? 'present' : 'absent'}; responseChars=${response.length}; session=${sessionId && /^[a-f0-9-]{36}$/i.test(sessionId) ? sessionId : 'unknown'}.\n`);
    if (envelope.status !== 'SUCCESS') {
      const error = typeof envelope.error === 'string' ? CompactProgress.diagnostics('Error: ' + envelope.error) : 'CLI не сообщил SUCCESS.';
      throw new Error('Antigravity CLI: ' + error);
    }
    let value: unknown = envelope.structured_output;
    if (!hasStructured && response.trim()) {
      try { value = JSON.parse(response.trim().replace(/^\x60\x60\x60(?:json)?\s*/, '').replace(/\s*\x60\x60\x60$/, '')); }
      catch { /* No prose extraction: a refusal or incomplete result is not a verdict. */ }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const outcome = value as AgentOutcome;
      if (AGENT_VERDICTS.includes(outcome.verdict) && typeof outcome.summary === 'string') return { text: JSON.stringify(outcome), sessionId };
    }
    if (/auto[- ]denied|soft[- ]denied|cannot prompt.*permission|permission.*(?:denied|required)|required.*permission|needs?.*approval/i.test(stderr))
      throw new Error('Antigravity не вернул результат: инструмент требует разрешения, которое нельзя запросить в headless. Настройте точечные permissions.allow в CLI; exit 0 не подтверждает выполнение задачи.');
    if (/authentication required|not authenticated|login required/i.test(stderr))
      throw new Error('Antigravity не вернул результат: требуется вход в CLI на компьютере worker.');
    throw new Error(`Antigravity не вернул verdict/summary по схеме (structured_output=${hasStructured ? 'present' : 'absent'}, responseChars=${response.length}). Ответ мог быть пустым, отказом или незавершённым. Проверьте права CLI и доступ к worktree; автоматический повтор модели не выполнялся.`);
  }
}
