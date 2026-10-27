import type { AgentRole } from './contracts.js';
import { WorkOrder, type StageEvidence, type WorkProgress } from './work-order.js';

type Fields = Record<string, unknown>;
export const HANDOFF_LIMITS = { taskChars: 40000, feedbackChars: 3000, diffChars: 16000, comments: 3, commentChars: 1000 } as const;

/** Retain the actual plan; drop repeated machine reports and bound optional handoff evidence. */
export class AgentHandoff {
  public static forRole(role: AgentRole, value: unknown, changedFiles: string[], previous?: StageEvidence, progress?: WorkProgress): string {
    const task = JSON.parse(this.task(value));
    const workOrder = WorkOrder.from(task.plan); delete task.plan;
    const evidence = previous ? { role: previous.role, sha: previous.sha, verdict: previous.verdict,
      current: previous.current, summary: this.feedback(previous.summary),
      changedFiles: previous.changedFiles, checks: previous.current === false ? [] : previous.checks } : undefined;
    const payload = JSON.stringify({ role, task, workOrder, changedFiles, previousStage: evidence, workProgress: progress });
    if (payload.length > HANDOFF_LIMITS.taskChars) throw new Error('Role handoff exceeds the limit; split the task. Requirements were not silently truncated.');
    return payload;
  }
  public static task(value: unknown): string {
    const source = value as Fields;
    const comments = (Array.isArray(source.comments) ? source.comments as Fields[] : [])
      .filter((comment) => /user|пользователь/i.test(String(comment.author)) || ['requirement', 'clarification', 'answer'].includes(String(comment.kind)))
      .slice(-HANDOFF_LIMITS.comments).map((comment) => ({ author: comment.author, kind: comment.kind, text: String(comment.text ?? '').slice(0, HANDOFF_LIMITS.commentChars) }));
    const result = JSON.stringify({ id: source.id, title: source.title, description: source.description,
      plan: source.plan, questions: source.questions, relations: source.relations, comments });
    if (result.length > HANDOFF_LIMITS.taskChars) throw new Error('Task context exceeds handoff limit. Split the task/plan before starting an agent; acceptance criteria were not silently truncated.');
    return result;
  }
  public static feedback(text: string): string { return text.length > HANDOFF_LIMITS.feedbackChars ? `[Earlier feedback omitted; inspect the report if needed.]\n${text.slice(-HANDOFF_LIMITS.feedbackChars)}` : text; }
  public static diff(text: string): string { return text.length > HANDOFF_LIMITS.diffChars ? `${text.slice(0, HANDOFF_LIMITS.diffChars)}\n[Diff preview limited. Inspect relevant changed files with git in the worktree.]` : text; }
  public static readonly instructions = 'Execute only the assigned role and the agreed plan. Do not narrate routine reasoning, reread unchanged evidence, or add meta-planning steps. '
    + 'Keep any command-output logs only inside .sat/logs/ (create that directory if needed), never in project source directories: on success print one line with command, exit status and test count; on failure print only the relevant error/trace and log path. '
    + 'Use focused source reads and tests. Do not repeat unchanged environment failures or dump whole files/logs. '
    + 'On Windows the command tool already uses PowerShell: do not nest powershell -Command or cmd /c wrappers. Use npm.cmd/npx.cmd when .ps1 shims are blocked; do not change execution policy. Use apply_patch for edits and simple shell commands instead of nested quoting or string-built replacement scripts. Check an instruction file exists before reading it. '
    + 'Report concrete changed files, validation results and remaining issues in a concise JSON summary (about 1200 characters); keep the analyst plan complete. Full execution logs stay outside the next agent prompt.';
}
