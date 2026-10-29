import type { TaskService } from '../services/task-service.js';
import type { AgentOutcome, AgentRun } from '../../../shared/automation/contracts.js';
import { Decomposition, type FeatureExecution, type FeatureCallBudget } from '../../../shared/automation/decomposition.js';
import { createHash } from 'node:crypto';

export class FeaturePlanning {
  public static requiredCalls(run: AgentRun, outcome: AgentOutcome): number {
    const parts = Decomposition.validate(outcome.decomposition);
    const pipeline = Decomposition.schedule(run.settings, run.stage, parts.length);
    return (run.usageAttempts?.length ?? 0) + pipeline.length - run.stage - 2;
  }
  public static apply(run: AgentRun, outcome: AgentOutcome, tasks: TaskService): { feature: FeatureExecution; pipeline: string[] } {
    const parts = Decomposition.validate(outcome.decomposition);
    const pipeline = Decomposition.schedule(run.settings, run.stage, parts.length);
    const callBudget = this.callBudget(run, outcome);
    const parent = tasks.getTaskCard(run.taskId);
    const children = parts.map((part, i) => {
      const child = tasks.createTask({ title: part.title, description: `${part.description}\n\nFeature: ${parent.id}. Execute only this child's plan. Siblings own the other deliverables. The following parent material defines shared constraints/contracts, not additional implementation steps.\n\n${parent.description ?? ''}\n\n${parent.plan?.content ?? ''}`, parentId: parent.id, type: 'task', actor: 'agent' });
      tasks.attachPlan({ id: child.id, planContent: part.plan, summary: `Decomposed from ${parent.id}: ${part.key}`, actor: 'agent' });
      return { ...part, taskId: child.id, developerStage: run.stage + 1 + i * 2, reviewerStage: run.stage + 2 + i * 2, state: 'ready' as const };
    });
    for (const child of children) for (const dependency of child.dependsOn) tasks.linkTasks(child.taskId, children.find(c => c.key === dependency)!.taskId, 'blocked_by');
    const requirementsKey = createHash('sha256').update(JSON.stringify({ description: parent.description, plan: parent.plan?.content })).digest('hex');
    return { pipeline, feature: { children, finalDeveloperStage: run.stage + 1 + children.length * 2, requirementsKey, callBudget } };
  }
  public static callBudget(run: AgentRun, outcome: AgentOutcome): FeatureCallBudget {
    const count = Decomposition.validate(outcome.decomposition).length;
    const pipeline = Decomposition.schedule(run.settings, run.stage, count);
    const planned = this.requiredCalls(run, outcome);
    const revisionSize = Math.max(2, pipeline.length - (run.stage + 1 + count * 2));
    const revisions = Math.max(0, run.settings.maxRevisions - run.revision) * revisionSize;
    const resolver = run.settings.mergePolicy === 'local' && run.settings.resolveConflicts !== false
      ? Math.max(0, (run.settings.maxResolverCalls ?? 1) - (run.usageAttempts ?? []).filter(a => a.kind === 'resolver').length) : 0;
    const limit = planned + revisions + resolver;
    if (limit > 100 && !run.trustedExecution) throw new Error('Feature exceeds the hard limit of 100 calls. Simplify the plan or reduce the configured revision allowance.');
    return { planned, revisions, resolver, limit };
  }
}
