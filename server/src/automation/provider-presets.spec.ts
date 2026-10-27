import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutomationSettingsValidator } from './settings.js';
import { CONNECTION_PRESETS } from '../../../shared/automation/presets.js';
import { DEFAULT_AUTOMATION_SETTINGS, RUNNER_IDS, ProviderKind, RunnerId } from '../../../shared/automation/contracts.js';

test('every supported runner is available through a connection preset and native selection survives renamed labels', () => {
  assert.deepEqual(new Set(CONNECTION_PRESETS.map(p => p.runner)), new Set(RUNNER_IDS));
  const validator = new AutomationSettingsValidator();
  for (const preset of CONNECTION_PRESETS) {
    const settings = validator.validate({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS),
      connections: [{ ...preset.connection, id: preset.id, label: 'Переименованное подключение' }] });
    assert.equal(settings.connections[0].nativeRunner, preset.connection.kind === ProviderKind.Native ? preset.runner : undefined);
  }
  assert.throws(() => validator.validate({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS),
    connections: [{ id: 'bad', label: 'Native', kind: ProviderKind.Native, supportsImages: false, nativeRunner: RunnerId.ModelApi }] }), /native runner/);
});
