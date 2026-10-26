/** Nested agents read task context; the worker alone changes task/run lifecycle. */
export const AGENT_TRACKER_READ_TOOLS = ['tracker_get_task', 'tracker_get_instructions', 'tracker_list_tasks', 'tracker_search_tasks', 'tracker_list_tags'] as const;
export const AGENT_TRACKER_SERVER = 'simple-ai-tracker';
