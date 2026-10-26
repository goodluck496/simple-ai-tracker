import { RunnerId, type AgentRunner } from '../../../../shared/automation/contracts.js';
import { NativeAgentRunner } from './native-runner.js';
import { ModelApiRunner } from './model-api-runner.js';

export class AgentRunnerRegistry {
  public get(id: RunnerId): AgentRunner {
    return id === RunnerId.ModelApi ? new ModelApiRunner() : new NativeAgentRunner(id);
  }
}
