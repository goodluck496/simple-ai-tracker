import type { AgentRole } from './contracts.js';
import { WorkOrder, type StageEvidence, type WorkProgress } from './work-order.js';

type Fields = Record<string, unknown>;
export const HANDOFF_LIMITS = { taskChars: 40000, feedbackChars: 1200, diffChars: 6000, comments: 2, commentChars: 600 } as const;

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
      plan: source.plan, questions: source.questions, relations: source.relations, comments,
      progressNotes: (Array.isArray(source.comments) ? source.comments as Fields[] : [])
        .filter(comment => String(comment.text ?? '').startsWith('[CHECKPOINT ')).slice(-1)
        .map(comment => ({ text: String(comment.text).slice(0, 3800), unverified: true })) });
    if (result.length > HANDOFF_LIMITS.taskChars) throw new Error('Task context exceeds handoff limit. Split the task/plan before starting an agent; acceptance criteria were not silently truncated.');
    return result;
  }
  public static feedback(text: string): string { return text.length > HANDOFF_LIMITS.feedbackChars ? `[Earlier feedback omitted; inspect the report if needed.]\n${text.slice(-HANDOFF_LIMITS.feedbackChars)}` : text; }
  public static diff(text: string): string { return text.length > HANDOFF_LIMITS.diffChars ? `${text.slice(0, HANDOFF_LIMITS.diffChars)}\n[Diff preview limited. Inspect relevant changed files with git in the worktree.]` : text; }
  public static readonly instructions = 'Execute only the assigned role and the agreed plan. Do not narrate routine reasoning, reread unchanged evidence, or add meta-planning steps. '
    + 'Persist useful intermediate results for EVERY role: after a meaningful finding, completed work step, or before a long check/stop, write .sat/stage-note.json as {"key":"copy key from .sat/stage-context.json","note":{"summary":"short factual prose","implementationPlan":["exact file, change, focused check; required if no plan"],"findings":["confirmed fact"],"completedSteps":["actual step ID"],"nextStep":"one concrete next action","files":["path#symbol"],"checks":["command: exit code and result"]}}. Read the stage-context key once. Omit unused optional lists. Do not write a note just to count tools or repeat unchanged facts. The worker publishes this mailbox through tracker MCP to the assigned card; do not write tracker data through files or HTTP. The mailbox is an unverified progress hint, not task storage. Keep the note under 3000 characters, one short sentence per field/list item, no source code, code blocks, JSON snippets, diffs, command output or internal reasoning. Save before long checks and before returning a question or final outcome. Return structured questions in the final outcome: the worker publishes them to the card. '
    + 'Writing the .sat runtime journal is allowed for read-only roles too; project sources remain read-only. Include nextStep whenever work remains; it may be omitted in the final note before returning the outcome. Finish the assigned step within the stated tool budget. Do not spend all calls on exploration: localize, checkpoint facts, make the planned change or return the concrete blocker. On continuation, use partialCheckpoint as a starting point, verify its relevant paths against current worktree code and avoid repeating general research. The repository is always the source of current code. Never treat saved notes as proof of passing tests. '
    + 'CodeGraph is required when .codegraph exists: use codegraph_explore with maxFiles=1 for exactly ONE method/symbol per query, never a whole file or subsystem. API tool runners use explore_code(symbol); other CLI runners without MCP use codegraph explore "ExactClass.method" in the current worktree. Do not share indexes between worktrees. '
    + 'Tracker MCP is available read-only in native Codex: use tracker_get_task for the assigned task and workspace. The worker owns lifecycle writes; return your outcome instead of changing task status yourself. Tracker data-access prohibitions apply to task data, not repository source code: focused source reads and patches are allowed. Missing .sat/work-progress.json means there are no saved progress hints; it is not an error or a blocker. Inspect the existing diff and proceed with the approved work order. '
    + 'Keep any command-output logs only inside .sat/logs/ (create that directory if needed), never in project source directories: on success print one line with command, exit status and test count; on failure print only the relevant error/trace and log path. '
    + 'Use apply_patch for focused edits. Before editing, read only the required symbol or a single range of at most 40 lines in one file per command. Search for locations first. Do not concatenate multiple source reads, echo file bodies/diffs, rewrite unchanged files or reread unchanged context. Report paths and results, never source code. Do not repeat unchanged environment failures or dump whole files/logs. '
    + 'On Windows the command tool already uses PowerShell: do not nest powershell -Command or cmd /c wrappers. Use npm.cmd/npx.cmd when .ps1 shims are blocked; do not change execution policy. Use apply_patch for edits and simple shell commands instead of nested quoting or string-built replacement scripts. Check an instruction file exists before reading it. '
    + 'Report concrete changed files, validation results and remaining issues in a concise JSON summary (about 1200 characters); keep the analyst plan complete. Full execution logs stay outside the next agent prompt.';
}
