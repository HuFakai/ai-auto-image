[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ScriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptRoot "..")).Path
$ToolsRoot = Join-Path $ProjectRoot ".windows-tools"
$currentProcessId = $PID
$managedPatterns = @(
    '\.windows-tools\\(?:api|studio)-start\.cmd',
    'api[\\/]app\.py',
    'studio[\\/]node_modules[\\/]next',
    'scripts[\\/]run_production\.py',
    'hyperframes-renderer[\\/]scripts[\\/]server\.mjs'
)

function Test-ProjectProcess {
    param($Process)
    if (-not $Process -or [int]$Process.ProcessId -eq $currentProcessId) { return $false }
    $commandLine = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
    if ($commandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $false
    }
    foreach ($pattern in $managedPatterns) {
        if ($commandLine -match $pattern) { return $true }
    }
    return $false
}

function Add-ProcessTree {
    param(
        [int]$RootId,
        [object[]]$Snapshot,
        [System.Collections.Generic.HashSet[int]]$Seen,
        [System.Collections.Generic.List[int]]$Order
    )
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootId)
    while ($queue.Count -gt 0) {
        $processId = $queue.Dequeue()
        if (-not $Seen.Add($processId)) { continue }
        $Order.Add($processId)
        foreach ($child in $Snapshot) {
            if ([int]$child.ParentProcessId -eq $processId) {
                $queue.Enqueue([int]$child.ProcessId)
            }
        }
    }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Pixelle Video - Windows one-click stop" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

try {
    $snapshot = @(Get-CimInstance Win32_Process)
    $roots = New-Object System.Collections.Generic.HashSet[int]

    foreach ($pidName in @("api.pid", "studio.pid")) {
        $pidPath = Join-Path $ToolsRoot $pidName
        if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { continue }
        $candidate = 0
        $raw = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if (-not [int]::TryParse($raw, [ref]$candidate)) { continue }
        $process = $snapshot | Where-Object { [int]$_.ProcessId -eq $candidate } | Select-Object -First 1
        if (Test-ProjectProcess $process) { [void]$roots.Add($candidate) }
    }

    # Fallback for services started manually or by an older launcher without PID files.
    foreach ($process in $snapshot) {
        if (Test-ProjectProcess $process) {
            [void]$roots.Add([int]$process.ProcessId)
        }
    }

    $seen = New-Object System.Collections.Generic.HashSet[int]
    $order = New-Object System.Collections.Generic.List[int]
    foreach ($rootId in $roots) {
        Add-ProcessTree -RootId $rootId -Snapshot $snapshot -Seen $seen -Order $order
    }

    $stopped = 0
    for ($index = $order.Count - 1; $index -ge 0; $index--) {
        $processId = $order[$index]
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host ("  Stopped: {0} (PID {1})" -f $process.ProcessName, $processId) -ForegroundColor Green
            $stopped += 1
        }
        catch {
            Write-Host ("  Could not stop PID {0}: {1}" -f $processId, $_.Exception.Message) -ForegroundColor Yellow
        }
    }

    foreach ($pidName in @("api.pid", "studio.pid")) {
        $pidPath = Join-Path $ToolsRoot $pidName
        if (Test-Path -LiteralPath $pidPath) {
            Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        }
    }

    if ($stopped -eq 0) {
        Write-Host "No Pixelle Video processes are currently running." -ForegroundColor Yellow
    }
    else {
        Write-Host ("Pixelle Video stopped successfully ({0} processes)." -f $stopped) -ForegroundColor Green
    }
    exit 0
}
catch {
    Write-Host ("STOP FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
