type Fields = Record<string, unknown>;
export const HANDOFF_LIMITS = { taskChars: 40000, feedbackChars: 3000, diffChars: 16000, comments: 3, commentChars: 1000 } as const;

/** Retain the actual plan; drop repeated machine reports and bound optional handoff evidence. */
export class AgentHandoff {
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
    + 'Keep command output in a local log: on success print one line with command, exit status and test count; on failure print only the relevant error/trace and log path. '
    + 'Use focused source reads and tests. Do not repeat unchanged environment failures or dump whole files/logs. '
    + 'Report concrete changed files, validation results and remaining issues in a concise JSON summary (about 1200 characters); keep the analyst plan complete. Full execution logs stay outside the next agent prompt.';
}
