# node-monitor Windows agent (Windows PowerShell 5.1+ / PowerShell 7).
# Task Scheduler runs it once a minute; each run pushes Samples metrics, one every
# Interval seconds, then exits. Config: C:\ProgramData\nodemon\agent.json
param(
  [string]$Config = "$env:ProgramData\nodemon\agent.json",
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
$AgentVersion = '1.0.0'

$cfg = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
$url = ([string]$cfg.url).TrimEnd('/')
$token = [string]$cfg.token
if (-not $url -or -not $token) { throw "url/token missing in $Config" }
$interval = if ($cfg.interval) { [int]$cfg.interval } else { 5 }
$samples = if ($Once) { 1 } elseif ($cfg.samples) { [int]$cfg.samples } else { 12 }

# One run at a time: skip if the previous minute's run is still going.
$mutex = New-Object System.Threading.Mutex($false, 'Global\nodemon-agent')
if (-not $mutex.WaitOne(0)) { exit 0 }

$skipNic = 'isatap|Teredo|Loopback|Tailscale|WireGuard|vEthernet|Hyper-V|VirtualBox|VMware|Pseudo|6to4'

function Read-Cpu {
  $p = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
  @{ idle = [double]$p.PercentProcessorTime; ts = [double]$p.Timestamp_Sys100NS }
}
function Read-Net {
  $rx = 0.0; $tx = 0.0
  foreach ($n in Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface) {
    if ($n.Name -match $skipNic) { continue }
    $rx += [double]$n.BytesReceivedPersec; $tx += [double]$n.BytesSentPersec
  }
  @{ rx = $rx; tx = $tx; t = [DateTime]::UtcNow }
}

try {
  $os0 = Get-CimInstance Win32_OperatingSystem
  $hostName = $env:COMPUTERNAME
  $osName = "$($os0.Caption) $($os0.OSArchitecture)".Trim()
  $kernel = [string]$os0.Version
  $boot = $os0.LastBootUpTime

  $pc = Read-Cpu; $pn = Read-Net
  Start-Sleep -Seconds 1

  for ($i = 1; $i -le $samples; $i++) {
    $start = [DateTime]::UtcNow
    $c = Read-Cpu; $n = Read-Net
    $dts = $c.ts - $pc.ts
    $cpu = if ($dts -gt 0) { [math]::Round([math]::Max(0, [math]::Min(100, 100 * (1 - ($c.idle - $pc.idle) / $dts))), 1) } else { 0 }
    $secs = [math]::Max(0.001, ($n.t - $pn.t).TotalSeconds)
    $rxs = [math]::Max(0, [math]::Round(($n.rx - $pn.rx) / $secs))
    $txs = [math]::Max(0, [math]::Round(($n.tx - $pn.tx) / $secs))
    $pc = $c; $pn = $n

    $os = Get-CimInstance Win32_OperatingSystem
    $memTotal = [int64]$os.TotalVisibleMemorySize * 1024
    $memUsed = $memTotal - [int64]$os.FreePhysicalMemory * 1024
    $swapTotal = [int64]0; $swapUsed = [int64]0
    foreach ($pf in Get-CimInstance Win32_PageFileUsage) {
      $swapTotal += [int64]$pf.AllocatedBaseSize * 1MB; $swapUsed += [int64]$pf.CurrentUsage * 1MB
    }
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 } | ForEach-Object {
      @{ mount = $_.DeviceID; total = [int64]$_.Size; used = [int64]$_.Size - [int64]$_.FreeSpace }
    })

    $body = @{
      agent_version = $AgentVersion; hostname = $hostName; os = $osName; kernel = $kernel
      cpu = $cpu; load1 = $null
      mem_total = $memTotal; mem_used = $memUsed; swap_total = $swapTotal; swap_used = $swapUsed
      net_rx = $rxs; net_tx = $txs
      procs = [int]$os.NumberOfProcesses
      uptime = [int64]([DateTime]::Now - $boot).TotalSeconds
      disks = $disks
    } | ConvertTo-Json -Compress -Depth 4

    $code = 0
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$url/api/ingest" -TimeoutSec 4 `
        -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
      $code = [int]$r.StatusCode
    } catch {
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    }
    if ($Once) { Write-Output "push -> HTTP $code"; if ($code -eq 204) { exit 0 } else { exit 1 } }
    if ($code -eq 401) { exit 1 }   # token revoked/rotated: stop until next run

    if ($i -lt $samples) {
      $left = $interval - ([DateTime]::UtcNow - $start).TotalSeconds
      Start-Sleep -Milliseconds ([int]([math]::Max(1, $left) * 1000))
    }
  }
} finally {
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
