param(
  [Parameter(Position=0)]
  [ValidateSet('install','uninstall','start','stop','status','restart','logs')]
  [string]$Action = 'status',
  [string]$Workspace = 'default'
)

$TaskName = "SimpleAiTrackerWorker"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodePath = (Get-Command node).Source
$ScriptPath = Join-Path $RepoRoot "scripts\worker-service.mjs"

switch ($Action) {
  'install' {
    Write-Host "[SimpleAiTracker] Регистрация фоновой задачи Windows '$TaskName'..."
    $actionCmd = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$ScriptPath`" start --workspace $Workspace" -WorkingDirectory $RepoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $actionCmd -Trigger $trigger -Settings $settings -Description "Simple AI Tracker local background worker service" -Force | Out-Null
    Write-Host "[SimpleAiTracker] ✓ Служба успешно зарегистрирована в Планировщике задач Windows!"
    Write-Host "  Она будет автоматически запускаться в фоне при входе в систему без всплывающих окон."
    Write-Host "  Для немедленного запуска: npm run worker:service:start"
  }
  'uninstall' {
    Write-Host "[SimpleAiTracker] Удаление фоновой задачи Windows '$TaskName'..."
    & node "$ScriptPath" stop
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    Write-Host "[SimpleAiTracker] ✓ Фоновая задача Windows удалена."
  }
  'start' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
      Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
    }
    & node "$ScriptPath" start --workspace $Workspace
  }
  'stop' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    & node "$ScriptPath" stop
  }
  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
      Write-Host "Планировщик Windows: Зарегистрирован (Состояние: $($task.State))"
    } else {
      Write-Host "Планировщик Windows: Не зарегистрирован (для автозапуска при входе: npm run worker:service:install)"
    }
    & node "$ScriptPath" status
  }
  'restart' {
    & node "$ScriptPath" restart
  }
  'logs' {
    & node "$ScriptPath" logs
  }
}
