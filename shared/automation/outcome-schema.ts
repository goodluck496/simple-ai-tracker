/** Codex structured output: named fields cannot be buried inside a prose summary. */
export const AGENT_OUTCOME_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes_requested', 'questions', 'blocked'] },
    summary: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    plan: { type: 'string' },
    commitMessage: { type: 'string' },
    decomposition: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, plan: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['key', 'title', 'description', 'plan', 'dependsOn'] } },
  },
  required: ['verdict', 'summary', 'questions', 'plan', 'commitMessage', 'decomposition'],
} as const;
