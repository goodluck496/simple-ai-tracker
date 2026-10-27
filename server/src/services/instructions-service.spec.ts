import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstructionsService } from './instructions-service.js';

describe('InstructionsService', () => {
  let appRoot: string;
  beforeEach(() => { appRoot = mkdtempSync(path.join(os.tmpdir(), 'sat-instructions-')); });
  afterEach(() => { rmSync(appRoot, { recursive: true, force: true }); });

  it('reads the repository instruction file from app root', () => {
    const contents = '# Current instructions\n';
    writeFileSync(path.join(appRoot, 'AGENT_INSTRUCTIONS.md'), contents);
    assert.equal(new InstructionsService(appRoot).get(), contents);
    const service = new InstructionsService(appRoot);
    const session = service.getSessionInstructions();
    assert.ok(session.length < 1600);
    assert.match(session, /tracker_get_instructions/);
    assert.match(session, /done/);
    assert.match(session, /MCP/);
    assert.equal(service.get(), contents);
  });

  it('uses its built-in fallback and warns when the file is missing', () => {
    const warnings: string[] = [];
    const service = new InstructionsService(appRoot, { warn: (message: string) => warnings.push(message) } as never);
    const fallback = service.get();
    assert.ok(fallback.includes('Simple AI Tracker'));
    assert.equal(service.get(), fallback);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /AGENT_INSTRUCTIONS\.md/);
  });
});
