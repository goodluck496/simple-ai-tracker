import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('manage-patch script check, save, clean, and restore lifecycle', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-patch-test-'));
  const scriptPath = path.resolve('scripts/manage-patch.mjs');

  try {
    // Init git repo
    execSync('git init', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.name "Tester"', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: tmp, stdio: 'pipe' });

    fs.writeFileSync(path.join(tmp, 'file1.txt'), 'base content\n', 'utf8');
    execSync('git add . && git commit -m "initial commit"', { cwd: tmp, stdio: 'pipe' });

    // Step 1: Check clean
    const checkClean = spawnSync('node', [scriptPath, 'check', '--json'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(checkClean.status, 0);
    const parsedClean = JSON.parse(checkClean.stdout);
    assert.equal(parsedClean.clean, true);

    // Step 2: Make tracked change and untracked file
    fs.writeFileSync(path.join(tmp, 'file1.txt'), 'modified content\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'file2.txt'), 'new untracked file\n', 'utf8');

    // Step 3: Check dirty
    const checkDirty = spawnSync('node', [scriptPath, 'check', '--json'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(checkDirty.status, 0);
    const parsedDirty = JSON.parse(checkDirty.stdout);
    assert.equal(parsedDirty.clean, false);
    assert.equal(parsedDirty.count, 2);

    // Step 4: Save patch
    const saveRes = spawnSync('node', [scriptPath, 'save', 'my_custom_patch', '--json'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(saveRes.status, 0, saveRes.stderr);
    const parsedSave = JSON.parse(saveRes.stdout);
    assert.equal(parsedSave.status, 'saved');

    const expectedPatchFile = path.join(tmp, 'patches', 'my_custom_patch.patch');
    assert.ok(fs.existsSync(expectedPatchFile), 'Patch file should exist');

    // Verify tree is now clean
    assert.equal(fs.readFileSync(path.join(tmp, 'file1.txt'), 'utf8').trim(), 'base content');
    assert.ok(!fs.existsSync(path.join(tmp, 'file2.txt')), 'Untracked file should be cleaned');

    // Step 5: Simulate doing task work and committing it
    fs.writeFileSync(path.join(tmp, 'task_work.txt'), 'task completed\n', 'utf8');
    execSync('git add . && git commit -m "feat: completed task"', { cwd: tmp, stdio: 'pipe' });

    // Step 6: Restore patch
    const restoreRes = spawnSync('node', [scriptPath, 'restore', '--json'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(restoreRes.status, 0, restoreRes.stderr);
    const parsedRestore = JSON.parse(restoreRes.stdout);
    assert.equal(parsedRestore.status, 'restored');

    // Verify restored contents
    assert.equal(fs.readFileSync(path.join(tmp, 'file1.txt'), 'utf8').trim(), 'modified content');
    assert.equal(fs.readFileSync(path.join(tmp, 'file2.txt'), 'utf8').trim(), 'new untracked file');
    assert.equal(fs.readFileSync(path.join(tmp, 'task_work.txt'), 'utf8').trim(), 'task completed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
