# 注册 GitHub 巡检计划任务（默认每 30 分钟）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-patrol-task.ps1
#   powershell ... -File scripts/install-patrol-task.ps1 -IntervalMinutes 15
#   powershell ... -File scripts/install-patrol-task.ps1 -RepoRoot "D:\dsh-build\magpie-Jet-Hub"
#   powershell ... -File scripts/install-patrol-task.ps1 -Uninstall
#
# 为什么用 XML 注册而不是 Register-ScheduledTask -Trigger：
#   New-ScheduledTaskTrigger -RepetitionDuration ([TimeSpan]::MaxValue) 会生成
#   P99999999DT23H59M59S，超出任务计划程序 XML 的 Duration 上限而报
#   HRESULT 0x80041318。无限重复的正确写法是**省略 Duration 元素**，
#   XML 直接注册可以精确表达这一点。

param(
  [string]$TaskName = 'DSH-GitHub-Patrol',
  [int]$IntervalMinutes = 30,
  [string]$RepoRoot = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "已删除计划任务：$TaskName"
  } else {
    Write-Output "计划任务不存在：$TaskName"
  }
  return
}

# --- 定位仓库根 ---------------------------------------------------------------
# 某些 PowerShell 宿主下 $PSScriptRoot 为空（被 bash 以 -File 调起时见过），
# 所以给出多条兜底路径，逐条验证 scripts\gh-patrol.mjs 是否存在。
$candidates = @()
if ($RepoRoot) { $candidates += $RepoRoot }
if ($PSScriptRoot) { $candidates += (Split-Path -Parent $PSScriptRoot) }
if ($MyInvocation.MyCommand.Path) {
  $candidates += (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
}
$candidates += (Get-Location).Path

$repoRoot = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path (Join-Path $c 'scripts\gh-patrol.mjs'))) {
    $repoRoot = (Resolve-Path $c).Path
    break
  }
}
if (-not $repoRoot) {
  throw '找不到仓库根目录（缺少 scripts\gh-patrol.mjs）。请用 -RepoRoot 显式指定。'
}

$patrolScript = Join-Path $repoRoot 'scripts\gh-patrol.mjs'

# --- 定位 node ----------------------------------------------------------------
# 计划任务的环境变量和交互式 shell 不同，不能指望 PATH 里有 node。
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($p in @('D:\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe')) {
    if (Test-Path $p) { $node = $p; break }
  }
}
if (-not $node) { throw '找不到 node.exe' }

$logDir = Join-Path $env:USERPROFILE '.dsh\jet-hub\patrol'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'patrol.log'

# --- 构造任务 XML -------------------------------------------------------------
# Arguments 里不放 `cd /d ... &&`：WorkingDirectory 已经指定了工作目录，
# 少一层 cmd 解析就少一类引号事故。
$argLine = "/d /c `"`"$node`" `"$patrolScript`" --notify >> `"$log`" 2>&1`""

# 从下一个 IntervalMinutes 整点开始（例如 14:43 → 15:00 起的 30 分网格）
$now = Get-Date
$next = $now.Date.AddHours($now.Hour).AddMinutes(
  [math]::Floor($now.Minute / $IntervalMinutes) * $IntervalMinutes
).AddMinutes($IntervalMinutes)

$startBoundary = $next.ToString('yyyy-MM-ddTHH:mm:ss')
$description = "GitHub issue/PR 收件箱巡检（每 $IntervalMinutes 分钟，只读）。报告与日志：$logDir"
$userId = "$env:USERDOMAIN\$env:USERNAME"

# 关键：<Repetition> 里只写 <Interval>，不写 <Duration> → 无限重复。
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$description</Description>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT$($IntervalMinutes)M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userId</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>$([System.Security.SecurityElement]::Escape($argLine))</Arguments>
      <WorkingDirectory>$repoRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "已移除同名旧任务，准备重建。"
}

Register-ScheduledTask -TaskName $TaskName -Xml $xml | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output "已注册计划任务：$($t.TaskName)"
Write-Output "  状态：$($t.State)"
Write-Output "  首次运行：$($next.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Output "  重复间隔：每 $IntervalMinutes 分钟（无限重复）"
Write-Output "  node：$node"
Write-Output "  工作目录：$repoRoot"
Write-Output "  日志：$log"
Write-Output "  下次运行：$($info.NextRunTime)"
