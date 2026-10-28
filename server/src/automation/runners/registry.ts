import { RunnerId, type AgentRunner } from '../../../../shared/automation/contracts.js';
import { NativeAgentRunner } from './native-runner.js';
import { ModelApiRunner } from './model-api-runner.js';
import { ProjectEnvironment } from './project-environment.js';

export class AgentRunnerRegistry {
  public get(id: RunnerId): AgentRunner {
    const runner = id === RunnerId.ModelApi ? new ModelApiRunner() : new NativeAgentRunner(id);
    return { id, run: async (job, progress) => runner.run(await new ProjectEnvironment().prepare(job, progress), progress) };
  }
}
