import type { TaskService } from '../services/task-service.js';
import type { AgentOutcome, AgentRun } from '../../../shared/automation/contracts.js';
import { Decomposition, type FeatureExecution } from '../../../shared/automation/decomposition.js';
import { createHash } from 'node:crypto';

export class FeaturePlanning {
  public static apply(run: AgentRun, outcome: AgentOutcome, tasks: TaskService): { feature: FeatureExecution; pipeline: string[] } {
    const parts = Decomposition.validate(outcome.decomposition);
    const pipeline = Decomposition.schedule(run.settings, run.stage, parts.length);
    const calls = (run.usageAttempts?.length ?? 0) + parts.length * 2 + pipeline.length - (run.stage + 1 + parts.length * 2 + 1);
    if (calls > (run.settings.maxAgentCalls ?? 6)) throw new Error(`Decomposition needs at least ${calls} total agent calls; current limit is ${run.settings.maxAgentCalls ?? 6}. Increase the run budget explicitly, then resume; no children were dispatched.`);
    const parent = tasks.getTaskCard(run.taskId);
    const children = parts.map((part, i) => {
      const child = tasks.createTask({ title: part.title, description: `${part.description}\n\nFeature: ${parent.id}. Execute only this child's plan. Siblings own the other deliverables. The following parent material defines shared constraints/contracts, not additional implementation steps.\n\n${parent.description ?? ''}\n\n${parent.plan?.content ?? ''}`, parentId: parent.id, type: 'task', actor: 'agent' });
      tasks.attachPlan({ id: child.id, planContent: part.plan, summary: `Decomposed from ${parent.id}: ${part.key}`, actor: 'agent' });
      return { ...part, taskId: child.id, developerStage: run.stage + 1 + i * 2, reviewerStage: run.stage + 2 + i * 2, state: 'ready' as const };
    });
    for (const child of children) for (const dependency of child.dependsOn) tasks.linkTasks(child.taskId, children.find(c => c.key === dependency)!.taskId, 'blocked_by');
    const requirementsKey = createHash('sha256').update(JSON.stringify({ description: parent.description, plan: parent.plan?.content })).digest('hex');
    return { pipeline, feature: { children, finalDeveloperStage: run.stage + 1 + children.length * 2, requirementsKey } };
  }
}
