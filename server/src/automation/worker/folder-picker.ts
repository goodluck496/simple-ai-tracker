import { ProcessExecutor } from '../runners/process-executor.js';
import { PROJECT_LIMITS, WorkerPlatform } from '../../../../shared/automation/project.js';

export interface FolderPicker { pick(initialPath: string): Promise<string | null>; }

/** User-visible OS dialog; project paths are passed as data through the environment. */
export class WindowsFolderPicker implements FolderPicker {
  public constructor(private readonly executor: Pick<ProcessExecutor, 'run'> = new ProcessExecutor(), private readonly platform: string = process.platform) {}
  public async pick(initialPath: string): Promise<string | null> {
    if (this.platform !== WorkerPlatform.Windows) throw new Error('Системный диалог доступен на Windows worker. Используйте обзор каталогов.');
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$satDialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$satDialog.Description = 'Select a Git project folder for Simple AI Tracker'",
      '$satDialog.ShowNewFolderButton = $false',
      'if ([System.IO.Directory]::Exists($env:SAT_PICKER_PATH)) { $satDialog.SelectedPath = $env:SAT_PICKER_PATH }',
      '$satOwner = New-Object System.Windows.Forms.Form',
      '$satOwner.TopMost = $true; $satOwner.ShowInTaskbar = $false; $satOwner.Opacity = 0',
      'try { $satOwner.Show(); if ($satDialog.ShowDialog($satOwner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($satDialog.SelectedPath) } }',
      'finally { $satDialog.Dispose(); $satOwner.Dispose() }',
    ].join('\n');
    const result = await this.executor.run({ command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script],
      cwd: process.env.SystemRoot ?? process.cwd(), env: { ...process.env, SAT_PICKER_PATH: initialPath },
      signal: AbortSignal.timeout(PROJECT_LIMITS.requestMs - PROJECT_LIMITS.pollMs) });
    return result.trim() || null;
  }
}
