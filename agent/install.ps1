# node-monitor Windows installer. Run in an elevated PowerShell:
#   irm http://HUB:8787/install.ps1 -OutFile $env:TEMP\nm-install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\nm-install.ps1 -Url http://HUB:8787 -Token nmn_xxx
#   ... -File $env:TEMP\nm-install.ps1 -Uninstall
param(
  [string]$Url,
  [string]$Token,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$dir = "$env:ProgramData\nodemon"
$task = 'nodemon-agent'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in an elevated (Administrator) PowerShell.' }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output 'nodemon-agent removed.'
  return
}

if (-not $Url -or -not $Token) { throw 'Need -Url and -Token.' }
if ($Token -notmatch '^nmn_[A-Za-z0-9_-]{20,100}$') { throw 'Token must look like nmn_...' }
$Url = $Url.TrimEnd('/')

New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Lock the folder to SYSTEM + Administrators: the config holds the node token.
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

Invoke-WebRequest -UseBasicParsing -Uri "$Url/agent/nodemon-agent.ps1" -OutFile "$dir\nodemon-agent.ps1"
@{ url = $Url; token = $Token; interval = 5; samples = 12 } | ConvertTo-Json | Set-Content -LiteralPath "$dir\agent.json" -Encoding ASCII

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction -Execute $ps `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\nodemon-agent.ps1`""
# Cron equivalent: fire every minute, forever.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

& $ps -NoProfile -ExecutionPolicy Bypass -File "$dir\nodemon-agent.ps1" -Once
if ($LASTEXITCODE -eq 0) {
  Write-Output 'nodemon-agent installed. Scheduled task pushes every 5s.'
} else {
  Write-Error 'Installed, but the test push failed. Check URL/token and that the hub is reachable.'
}
