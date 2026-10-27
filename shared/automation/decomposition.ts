import type { AgentRun, AutomationSettings } from './contracts.js';

export interface DecomposedTask { key: string; title: string; description: string; plan: string; dependsOn: string[]; }
export interface FeatureChild extends DecomposedTask {
  taskId: string; developerStage: number; reviewerStage: number; state: 'ready' | 'review' | 'merged';
  sourceSha?: string; mergedSha?: string; commitMessage?: string;
}
export interface FeatureExecution { children: FeatureChild[]; finalDeveloperStage: number; requirementsKey: string; }

/** Bounded, deterministic DAG: no recursive analysts or independent child budgets. */
export class Decomposition {
  public static validate(value: unknown): DecomposedTask[] {
    if (!Array.isArray(value) || value.length < 2 || value.length > 12) throw new Error('Decomposition requires 2–12 small tasks.');
    const tasks = value.map(v => {
      if (!v || typeof v !== 'object' || typeof v.key !== 'string' || !/^[a-zA-Z][\w-]{0,39}$/.test(v.key)
        || !['title', 'description', 'plan'].every(k => typeof v[k] === 'string' && v[k].trim())
        || v.title.length > 240 || v.description.length > 8000 || v.plan.length > 16000
        || !Array.isArray(v.dependsOn) || !v.dependsOn.every((k: unknown) => typeof k === 'string')) throw new Error('Each child needs a key, title, description, complete plan and dependencies.');
      return { key: v.key, title: v.title, description: v.description, plan: v.plan, dependsOn: [...new Set<string>(v.dependsOn)] };
    });
    const keys = new Set(tasks.map(t => t.key));
    if (keys.size !== tasks.length || new Set(tasks.map(t => t.key.toLowerCase())).size !== tasks.length || tasks.some(t => t.dependsOn.some(k => !keys.has(k) || k === t.key))) throw new Error('Duplicate keys or unknown/self dependencies.');
    const ordered: DecomposedTask[] = []; const seen = new Set<string>();
    while (ordered.length < tasks.length) {
      const next = tasks.find(t => !seen.has(t.key) && t.dependsOn.every(k => seen.has(k)));
      if (!next) throw new Error('Decomposition dependencies contain a cycle.');
      seen.add(next.key); ordered.push(next);
    }
    if (JSON.stringify(ordered).length > 32000) throw new Error('Decomposition exceeds the context packet limit; use smaller tasks.');
    return ordered;
  }
  public static child(run: AgentRun): FeatureChild | undefined {
    return run.feature?.children.find(c => c.developerStage === run.stage || c.reviewerStage === run.stage);
  }
  public static schedule(settings: AutomationSettings, stage: number, count: number) {
    const role = (name: string) => settings.pipeline.find(id => settings.agents.find(a => a.id === id)?.role === name)!;
    const developer = role('developer'); const reviewer = role('reviewer');
    const tail = settings.pipeline.slice(stage + 1).filter(id => settings.agents.find(a => a.id === id)?.role !== 'developer');
    return [...settings.pipeline.slice(0, stage + 1), ...Array.from({ length: count }, () => [developer, reviewer]).flat(), developer, ...tail];
  }
}
