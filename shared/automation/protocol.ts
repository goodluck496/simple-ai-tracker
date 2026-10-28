export const AUTOMATION_TOOL_PREFIX = 'tracker_automation_';
export const AutomationTool = {
  Configure: `${AUTOMATION_TOOL_PREFIX}configure`, Settings: `${AUTOMATION_TOOL_PREFIX}settings`,
  TaskTeam: `${AUTOMATION_TOOL_PREFIX}task_team`,
  ListRuns: `${AUTOMATION_TOOL_PREFIX}list_runs`, GetRun: `${AUTOMATION_TOOL_PREFIX}get_run`,
  History: `${AUTOMATION_TOOL_PREFIX}history`, Archive: `${AUTOMATION_TOOL_PREFIX}archive`, Cleanup: `${AUTOMATION_TOOL_PREFIX}cleanup`, Delete: `${AUTOMATION_TOOL_PREFIX}delete`,
  Enqueue: `${AUTOMATION_TOOL_PREFIX}enqueue`, Claim: `${AUTOMATION_TOOL_PREFIX}claim`,
  Heartbeat: `${AUTOMATION_TOOL_PREFIX}heartbeat`, Progress: `${AUTOMATION_TOOL_PREFIX}progress`,
  Usage: `${AUTOMATION_TOOL_PREFIX}usage`,
  BeginStage: `${AUTOMATION_TOOL_PREFIX}begin_stage`, CompleteStage: `${AUTOMATION_TOOL_PREFIX}complete_stage`,
  Fail: `${AUTOMATION_TOOL_PREFIX}fail`, Cancel: `${AUTOMATION_TOOL_PREFIX}cancel`,
  Resume: `${AUTOMATION_TOOL_PREFIX}resume`, Merged: `${AUTOMATION_TOOL_PREFIX}merged`,
  Checkout: `${AUTOMATION_TOOL_PREFIX}checkout`, Integration: `${AUTOMATION_TOOL_PREFIX}integration`,
  HostPoll: `${AUTOMATION_TOOL_PREFIX}host_poll`, HostComplete: `${AUTOMATION_TOOL_PREFIX}host_complete`,
  HostStatus: `${AUTOMATION_TOOL_PREFIX}host_status`, WorkerStart: `${AUTOMATION_TOOL_PREFIX}worker_start`, WorkerStop: `${AUTOMATION_TOOL_PREFIX}worker_stop`,
} as const;
export type AutomationTool = typeof AutomationTool[keyof typeof AutomationTool];
export const AUTOMATION_TOOLS = Object.values(AutomationTool);
