export const DEFAULT_TRACKER_CONTAINER = 'simple-ai-tracker';
export const PORTABLE_WORKER_FILENAME = 'worker-host.cjs';
/** Connects a computer; project selection is a later, independent step. */
export class WorkerLaunchCommand {
  public static create(workspace: string, container = DEFAULT_TRACKER_CONTAINER): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(workspace)) throw new Error('Некорректное имя пространства.');
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(container)) throw new Error('Некорректное имя Docker-контейнера.');
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const args = `--workspace ${literal(workspace)} --container ${literal(container)}`;
    return [
      '& {',
      "  $ErrorActionPreference = 'Stop'",
      '  Get-Command node, docker, git, codegraph -ErrorAction Stop | Out-Null',
      "  $satWorkerDir = Join-Path $env:LOCALAPPDATA 'SimpleAiTracker\\workers'",
      '  New-Item -ItemType Directory -Path $satWorkerDir -Force | Out-Null',
      `  $satWorkerFile = Join-Path $satWorkerDir ${literal(`worker-${workspace}.cjs`)}`,
      '  Push-Location -LiteralPath $satWorkerDir',
      '  try {',
      "    $satNodeMajor = [int]((& node -p 'process.versions.node.split(String.fromCharCode(46))[0]') | Select-Object -Last 1)",
      "    if ($satNodeMajor -lt 22) { throw 'Node.js 22 or newer is required for the tracker worker.' }",
      `    docker cp ${literal(`${container}:/app/dist/server/${PORTABLE_WORKER_FILENAME}`)} $satWorkerFile`,
      "    if ($LASTEXITCODE -ne 0) { throw 'Cannot copy worker from the tracker container. Update and start Docker first.' }",
      `    & node $satWorkerFile ${args}`,
      "    if ($LASTEXITCODE -ne 0) { throw 'Tracker worker stopped with an error. See the message above.' }",
      '  } finally { Pop-Location }',
      '}',
    ].join('\n');
  }
}
