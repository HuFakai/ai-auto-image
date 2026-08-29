[CmdletBinding()]
param(
    [switch]$StartRunner,
    [switch]$NoBrowser,
    [switch]$ForceInstall
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Resolve everything from this script's location.  The GitHub repository name
# (and therefore the folder chosen by a clone/download) is intentionally not
# part of any path used by the launcher.
$ScriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path -Path $ScriptRoot -ChildPath "..")).Path
$ProjectMarker = Join-Path -Path $ProjectRoot -ChildPath "pyproject.toml"
if (-not (Test-Path -LiteralPath $ProjectMarker -PathType Leaf)) {
    throw "Cannot locate the project root from this script. Expected: $ProjectMarker"
}
Set-Location -LiteralPath $ProjectRoot
$ToolsRoot = Join-Path $ProjectRoot ".windows-tools"
$StateRoot = Join-Path $ToolsRoot "state"
$LogFile = Join-Path $ProjectRoot "windows-startup.log"
$PythonVersion = "3.12.10"
$NodeVersion = "22.17.0"
$DefaultApiPort = 18123
$DefaultStudioPort = 13123

$PipMirrors = @(
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple/",
    "https://mirrors.cloud.tencent.com/pypi/simple",
    "https://pypi.mirrors.ustc.edu.cn/simple/",
    "https://repo.huaweicloud.com/repository/pypi/simple/",
    "https://pypi.org/simple"
)

$NpmMirrors = @(
    "https://registry.npmmirror.com",
    "https://mirrors.cloud.tencent.com/npm/",
    "https://repo.huaweicloud.com/repository/npm/",
    "https://registry.npmjs.org"
)

$PlaywrightMirrors = @(
    "https://npmmirror.com/mirrors/playwright",
    ""
)

# GitHub 加速代理：国内下载 GitHub 上的二进制（如 FFmpeg）时优先走这些代理，官方直连兜底。
# 代理服务可能不定期失效，脚本会逐个尝试并自动跳过不可用的。
$GithubProxyMirrors = @(
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://github.moeyy.xyz/",
    "https://gh.ddlc.top/"
)

function Write-Step {
    param([int]$Number, [string]$Message)
    Write-Host ""
    Write-Host ("[{0}/9] {1}" -f $Number, $Message) -ForegroundColor Cyan
    Add-Content -LiteralPath $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format s), $Message) -Encoding UTF8
}

function Write-Ok {
    param([string]$Message)
    Write-Host ("  OK: {0}" -f $Message) -ForegroundColor Green
}

function Write-WarnMessage {
    param([string]$Message)
    Write-Host ("  WARN: {0}" -f $Message) -ForegroundColor Yellow
}

function Get-ConfiguredPort {
    param([string]$EnvironmentName, [int]$DefaultPort)
    $raw = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultPort }

    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) {
        return $parsed
    }
    Write-WarnMessage ("Ignoring invalid {0}={1}; using {2}." -f $EnvironmentName, $raw, $DefaultPort)
    return $DefaultPort
}

function Test-PortAvailable {
    param([int]$Port)
    if ($Port -lt 1024 -or $Port -gt 65535) { return $false }
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $listener) { $listener.Stop() }
    }
}

function Find-FreePort {
    param([int]$StartingPort, [string]$ServiceName)
    $lastPort = [Math]::Min(65535, $StartingPort + 100)
    for ($candidate = $StartingPort; $candidate -le $lastPort; $candidate++) {
        if (Test-PortAvailable $candidate) { return $candidate }
    }
    throw ("{0} could not find a free local TCP port starting at {1}." -f $ServiceName, $StartingPort)
}

function Disable-ConsoleQuickEdit {
    # Classic Windows Console pauses the running process while text is selected.
    # Disable QuickEdit for this console only so an accidental mouse click cannot freeze setup.
    if ($env:OS -ne "Windows_NT") { return }
    try {
        if (-not ("PixelleConsole.NativeMethods" -as [type])) {
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace PixelleConsole {
    public static class NativeMethods {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
    }
}
"@
        }

        $inputHandle = [PixelleConsole.NativeMethods]::GetStdHandle(-10)
        [uint32]$mode = 0
        if ([PixelleConsole.NativeMethods]::GetConsoleMode($inputHandle, [ref]$mode)) {
            $enableExtendedFlags = [uint32]0x0080
            $enableQuickEditMode = [uint32]0x0040
            $newMode = ($mode -bor $enableExtendedFlags) -band (-bnot $enableQuickEditMode)
            [void][PixelleConsole.NativeMethods]::SetConsoleMode($inputHandle, [uint32]$newMode)
        }
    }
    catch {
        # Windows Terminal and redirected consoles may not expose a classic input handle.
    }
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @($machinePath, $userPath, $env:Path) | Where-Object { $_ }
    $env:Path = ($parts -join ";")
}

function Add-ProcessPath {
    param([string]$Path)
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        $items = $env:Path -split ";"
        if ($items -notcontains $Path) {
            $env:Path = "$Path;$env:Path"
        }
    }
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$FailureMessage
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)"
    }
}

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-CapturedProcess {
    param(
        [string]$FilePath,
        [string]$Arguments,
        [int]$TimeoutSeconds = 8
    )
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = $Arguments
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { return $null }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            return $null
        }
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $output = $process.StandardOutput.ReadToEnd()
        $stderr = $stderrTask.Result
        if ($process.ExitCode -ne 0) { return $null }
        return (($output + $stderr).Trim())
    }
    catch {
        return $null
    }
}

function Install-WithWinget {
    param([string]$Id, [string]$Name)
    if (-not (Test-Command "winget.exe")) {
        return $false
    }
    Write-Host "  Installing $Name with Windows Package Manager..."
    & winget.exe install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-WarnMessage "winget could not install $Name; a safe fallback will be tried."
        return $false
    }
    Refresh-ProcessPath
    return $true
}

function Get-InnermostMessage {
    param($ErrorRecord)
    $exception = $ErrorRecord.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    return $exception.Message
}

# 在严格模式下执行 Python 单行代码并返回退出码。
# Python 画板里的项目包（pixelle_video）在 import 时会向 stderr 打 WARNING，
# 而严格模式会把任何 stderr 输出误判为致命错误（RemoteException），导致脚本中断。
# 这里临时关闭严格模式，执行后恢复，并返回真实的 $LASTEXITCODE。
function Invoke-PythonCode {
    param([string]$PythonPath, [string]$Code)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        # Keep subprocess output visible without returning it as part of this
        # function's pipeline value; callers must receive one integer only.
        & $PythonPath -c $Code 2>$null | Out-Host
        return $LASTEXITCODE
    }
    catch {
        return 1
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

# 慢速源主动放弃信号：下载速度持续低于阈值时由监控逻辑抛出，外层自动换下一个源。
Add-Type -TypeDefinition @"
namespace Pixelle.Setup {
    public class SlowSourceException : System.Exception {
        public SlowSourceException(string message) : base(message) { }
    }
}
"@

# 单个 URL 测速：按 Range 下载样本并返回实测速度（字节/秒），失败返回 0。
function Measure-UrlSpeed {
    param([string]$Url, [int]$SampleBytes = 1572864, [int]$TimeoutSeconds = 12)
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    try {
        $client.DefaultRequestHeaders.UserAgent.ParseAdd("Pixelle-Video-Setup/1.0")
        $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Url)
        $request.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue(0, ($SampleBytes - 1))
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        if (-not $response.IsSuccessStatusCode) { return 0 }
        $stream = $response.Content.ReadAsStreamAsync().Result
        try {
            $buffer = New-Object byte[] 65536
            $totalBytes = 0
            while ($totalBytes -lt $SampleBytes) {
                $read = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, $SampleBytes - $totalBytes))
                if ($read -le 0) { break }
                $totalBytes += $read
            }
            $watch.Stop()
        }
        finally {
            $stream.Dispose()
            $response.Dispose()
        }
        if ($watch.Elapsed.TotalSeconds -le 0 -or $totalBytes -lt 65536) { return 0 }
        return [long]($totalBytes / $watch.Elapsed.TotalSeconds)
    }
    catch {
        return 0
    }
    finally {
        $client.Dispose()
    }
}

# 对镜像列表测速并按速度降序排序；速度单位换算为 KB/s 便于展示。
function Order-MirrorsBySpeed {
    param([string[]]$Mirrors, [string]$Label, [scriptblock]$SampleUrlBuilder)
    $results = New-Object System.Collections.Generic.List[object]
    foreach ($mirror in $Mirrors) {
        $sampleUrl = & $SampleUrlBuilder $mirror
        $speed = 0
        if ($sampleUrl) {
            $speed = Measure-UrlSpeed -Url $sampleUrl
        }
        $speedKb = [Math]::Round($speed / 1KB)
        if ($speed -gt 0) {
            Write-Host ("    {0} -> {1} KB/s" -f $mirror, $speedKb)
        }
        else {
            Write-Host ("    {0} -> unreachable" -f $mirror)
        }
        $results.Add([pscustomobject]@{ Mirror = $mirror; Speed = $speed })
    }
    $ranked = @($results | Sort-Object -Property Speed -Descending)
    $ordered = @($ranked | ForEach-Object { $_.Mirror })
    $usable = @($ranked | Where-Object { $_.Speed -gt 0 } | ForEach-Object { $_.Mirror })
    if ($usable.Count -gt 0) {
        Write-Ok ("Fastest {0} source: {1}" -f $Label, $usable[0])
        return @(($usable + $ordered) | Select-Object -Unique)
    }
    Write-WarnMessage "All $Label sources were unreachable during the speed test; original order will be used."
    return $ordered
}

# 缓存本轮测速结果，避免同一批镜像重复测速。
$script:MirrorSpeedCache = @{}

function Get-OrderedMirrors {
    param([string]$CacheKey, [string[]]$Mirrors, [string]$Label, [scriptblock]$SampleUrlBuilder)
    if ($script:MirrorSpeedCache.ContainsKey($CacheKey)) {
        return $script:MirrorSpeedCache[$CacheKey]
    }
    Write-Host ("  Speed-testing {0} sources..." -f $Label)
    $ordered = Order-MirrorsBySpeed -Mirrors $Mirrors -Label $Label -SampleUrlBuilder $SampleUrlBuilder
    $script:MirrorSpeedCache[$CacheKey] = $ordered
    return $ordered
}

# pip 测速样本：各镜像都同步了 PyPI 的 /packages/ 目录，用真实 wheel 文件测速最有代表性。
# pypi.org 的包文件不在本域，需要单独映射到 files.pythonhosted.org。
function Get-PipSampleUrl {
    param([string]$Mirror)
    $wheelPath = "packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl"
    if ($Mirror -match "^https://pypi\.org/simple/?$") {
        return "https://files.pythonhosted.org/$wheelPath"
    }
    $base = $Mirror -replace "/simple/?$", ""
    return "$base/$wheelPath"
}

# npm 测速样本：tarball 路径格式在 npmmirror、华为云和官方 registry 上一致。
function Get-NpmSampleUrl {
    param([string]$Mirror)
    return "$($Mirror.TrimEnd('/'))/react/-/react-18.3.1.tgz"
}

# GitHub 代理测速样本：只按 Range 读取开头 1.5MB，不会真的下载整个 FFmpeg。
function Get-GithubProxySampleUrl {
    param([string]$Proxy)
    return "${Proxy}https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
}

function Invoke-DownloadUrl {
    param([string]$Url, [string]$Destination, [int]$TimeoutSeconds)
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
    $cancellation = New-Object System.Threading.CancellationTokenSource([TimeSpan]::FromSeconds($TimeoutSeconds))
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    try {
        $client.DefaultRequestHeaders.UserAgent.ParseAdd("Pixelle-Video-Setup/1.0")
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).Result
        if (-not $response.IsSuccessStatusCode) {
            throw "HTTP $([int]$response.StatusCode)"
        }
        $totalBytes = $response.Content.Headers.ContentLength
        $source = $response.Content.ReadAsStreamAsync().Result
        $target = [System.IO.File]::Create($Destination)
        try {
            $buffer = New-Object byte[] 262144
            $downloadedBytes = 0
            $lastReportedBytes = 0
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            while (($read = $source.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).Result) -gt 0) {
                $target.Write($buffer, 0, $read)
                $downloadedBytes += $read
                if ($downloadedBytes - $lastReportedBytes -ge 8388608) {
                    $elapsedSeconds = $watch.Elapsed.TotalSeconds
                    $averageSpeed = 0
                    if ($elapsedSeconds -gt 0) { $averageSpeed = $downloadedBytes / $elapsedSeconds }
                    $speedKb = [Math]::Round($averageSpeed / 1KB)
                    if ($totalBytes -gt 0) {
                        Write-Host ("    {0:N1} / {1:N1} MB @ {2} KB/s" -f ($downloadedBytes / 1MB), ($totalBytes / 1MB), $speedKb)
                    }
                    else {
                        Write-Host ("    {0:N1} MB @ {1} KB/s" -f ($downloadedBytes / 1MB), $speedKb)
                    }
                    # 已下载足够多（>16MB）且平均速度仍低于 256 KB/s，判定为慢速源，主动中止换源。
                    if ($downloadedBytes -gt 16777216 -and $averageSpeed -lt 262144) {
                        throw [Pixelle.Setup.SlowSourceException]::new(
                            ("average speed {0} KB/s is below 256 KB/s" -f $speedKb))
                    }
                    $lastReportedBytes = $downloadedBytes
                }
            }
        }
        finally {
            $target.Dispose()
            $source.Dispose()
            $response.Dispose()
        }
    }
    finally {
        $client.Dispose()
        $cancellation.Dispose()
    }
}

function Invoke-Download {
    param(
        [string[]]$Urls,
        [string]$Destination,
        [long]$MinimumBytes = 1024,
        [int]$Retries = 1,
        [int]$TimeoutSeconds = 240,
        [scriptblock]$Verifier = $null
    )
    foreach ($url in $Urls) {
        for ($attempt = 0; $attempt -le $Retries; $attempt++) {
            try {
                if (Test-Path -LiteralPath $Destination) {
                    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
                }
                if ($attempt -gt 0) {
                    Write-WarnMessage "Retrying ($attempt of $Retries): $url"
                }
                else {
                    Write-Host "  Downloading from $url"
                }
                Invoke-DownloadUrl $url $Destination $TimeoutSeconds
                $length = (Get-Item -LiteralPath $Destination).Length
                if ($length -lt $MinimumBytes) {
                    throw "Downloaded file is unexpectedly small ($length bytes)."
                }
                if ($Verifier -and -not (& $Verifier $Destination)) {
                    throw "The downloaded file failed verification and will not be used."
                }
                Write-Ok ("Download complete: {0:N1} MB" -f ($length / 1MB))
                return
            }
            catch [Pixelle.Setup.SlowSourceException] {
                # 慢速源重试自己没有意义，直接换下一个源。
                Write-WarnMessage ("Source too slow, switching to the next one: {0}" -f (Get-InnermostMessage $_))
                break
            }
            catch {
                Write-WarnMessage ("Download failed: {0}" -f (Get-InnermostMessage $_))
            }
        }
    }
    throw "All download sources failed. Check the network and retry."
}

function Find-Python {
    $candidates = New-Object System.Collections.Generic.List[string]
    $known = @(
        (Join-Path $env:LocalAppData "Programs\Python\Python314\python.exe"),
        (Join-Path $env:LocalAppData "Programs\Python\Python313\python.exe"),
        (Join-Path $env:LocalAppData "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LocalAppData "Programs\Python\Python311\python.exe"),
        (Join-Path $env:ProgramFiles "Python314\python.exe"),
        (Join-Path $env:ProgramFiles "Python313\python.exe"),
        (Join-Path $env:ProgramFiles "Python312\python.exe"),
        (Join-Path $env:ProgramFiles "Python311\python.exe")
    )
    foreach ($path in $known) {
        if ($path -and (Test-Path -LiteralPath $path)) { $candidates.Add($path) }
    }

    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notmatch "\\Microsoft\\WindowsApps\\python(?:3)?\.exe$") {
        $candidates.Add($command.Source)
    }
    elseif ($command) {
        Write-WarnMessage "Ignoring the Windows Store python.exe alias."
    }

    if (Test-Command "py.exe") {
        $launcher = (Get-Command py.exe -ErrorAction SilentlyContinue).Source
        $launcherOutput = Invoke-CapturedProcess $launcher "-0p" 8
        if ($launcherOutput) {
            foreach ($line in ($launcherOutput -split "`r?`n")) {
                if ($line -match "([A-Za-z]:\\.*python\.exe)\s*$") {
                    $candidates.Add($Matches[1])
                }
            }
        }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        Write-Host "  Checking: $candidate"
        $rawVersion = Invoke-CapturedProcess $candidate '-c "import sys;print(sys.version.split()[0])"' 8
        if ($rawVersion) {
            try {
                $version = [version]$rawVersion
                if ($version -ge [version]"3.11.0") {
                    return $candidate
                }
            }
            catch { }
        }
    }
    return $null
}

function Install-PythonFallback {
    $installer = Join-Path $env:TEMP "python-$PythonVersion-amd64.exe"
    $urls = @(
        "https://mirrors.huaweicloud.com/python/$PythonVersion/python-$PythonVersion-amd64.exe",
        "https://mirrors.tuna.tsinghua.edu.cn/python/$PythonVersion/python-$PythonVersion-amd64.exe",
        "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
    )
    Invoke-Download -Urls $urls -Destination $installer -MinimumBytes 10000000

    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Python Software Foundation") {
        throw "The Python installer signature is not valid. The file was not executed."
    }

    Write-Host "  Running the verified Python installer..."
    $process = Start-Process -FilePath $installer -ArgumentList @(
        "/quiet",
        "InstallAllUsers=0",
        "PrependPath=1",
        "Include_launcher=1",
        "Include_test=0"
    ) -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Python installer failed with exit code $($process.ExitCode)."
    }
    Refresh-ProcessPath
}

function Find-Node {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @()
    if ($command) { $candidates += $command.Source }
    $candidates += @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path $ToolsRoot "node\node.exe")
    )
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        try {
            $rawVersion = Invoke-CapturedProcess $candidate "--version" 8
            if ($rawVersion -and [version]($rawVersion.TrimStart("v")) -ge [version]"22.0.0") {
                return $candidate
            }
        }
        catch { }
    }
    return $null
}

function Install-PortableNode {
    $archiveName = "node-v$NodeVersion-win-x64.zip"
    $archive = Join-Path $env:TEMP $archiveName
    $urls = @(
        "https://npmmirror.com/mirrors/node/v$NodeVersion/$archiveName",
        "https://mirrors.huaweicloud.com/nodejs/v$NodeVersion/$archiveName",
        "https://mirrors.aliyun.com/nodejs-release/v$NodeVersion/$archiveName",
        "https://nodejs.org/dist/v$NodeVersion/$archiveName"
    )
    Invoke-Download -Urls $urls -Destination $archive -MinimumBytes 10000000

    $checksumFile = Join-Path $env:TEMP "node-v$NodeVersion-SHASUMS256.txt"
    Invoke-Download -Urls @("https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt") -Destination $checksumFile
    $checksumLine = Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match [regex]::Escape($archiveName) } | Select-Object -First 1
    if (-not $checksumLine) { throw "Node.js checksum was not found." }
    $expectedHash = ($checksumLine -split "\s+")[0].ToUpperInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Node.js archive checksum mismatch. The file was not extracted."
    }

    $extractRoot = Join-Path $ToolsRoot "node-extract"
    $nodeRoot = Join-Path $ToolsRoot "node"
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
    $extracted = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $extracted -or -not (Test-Path -LiteralPath (Join-Path $extracted.FullName "node.exe"))) {
        throw "Portable Node.js archive has an unexpected layout."
    }
    Move-Item -LiteralPath $extracted.FullName -Destination $nodeRoot
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
    Add-ProcessPath $nodeRoot
}

function Find-FFmpegDirectory {
    $candidates = New-Object System.Collections.Generic.List[string]
    $command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) {
        $candidates.Add((Split-Path $command.Source -Parent))
    }
    $winGetPackages = Join-Path $env:LocalAppData "Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $winGetPackages) {
        Get-ChildItem -LiteralPath $winGetPackages -Filter ffmpeg.exe -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 3 | ForEach-Object { $candidates.Add($_.DirectoryName) }
    }
    $portable = Join-Path $ToolsRoot "ffmpeg\bin"
    if ((Test-Path -LiteralPath (Join-Path $portable "ffmpeg.exe")) -and (Test-Path -LiteralPath (Join-Path $portable "ffprobe.exe"))) {
        $candidates.Add($portable)
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $ffmpegExe = Join-Path $candidate "ffmpeg.exe"
        $ffprobeExe = Join-Path $candidate "ffprobe.exe"
        if (-not (Test-Path -LiteralPath $ffmpegExe) -or -not (Test-Path -LiteralPath $ffprobeExe)) { continue }
        $version = Invoke-CapturedProcess $ffmpegExe "-version" 10
        if ($version -match "ffmpeg version") { return $candidate }
        Write-WarnMessage "ffmpeg.exe at $candidate cannot run properly; it will be reinstalled."
    }
    return $null
}

function Test-FFmpegArchive {
    # Opens the zip and checks that it really contains both ffmpeg.exe and ffprobe.exe.
    param([string]$Path)
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
        try {
            $entryNames = @($zip.Entries | ForEach-Object { $_.FullName })
            $hasFfmpeg = @($entryNames -match "(?i)ffmpeg\.exe$").Count -gt 0
            $hasFfprobe = @($entryNames -match "(?i)ffprobe\.exe$").Count -gt 0
            return ($hasFfmpeg -and $hasFfprobe)
        }
        finally {
            $zip.Dispose()
        }
    }
    catch {
        return $false
    }
}

function Resolve-GyanReleaseAssetUrls {
    # The gyan GitHub release asset name includes the FFmpeg version, so resolve it from the
    # release page first. Returns an empty list when the page cannot be reached.
    $urls = New-Object System.Collections.Generic.List[string]
    try {
        $page = Invoke-WebRequest -Uri "https://github.com/GyanD/codexffmpeg/releases/latest" -UseBasicParsing -TimeoutSec 30
        if ($page.Content -match 'href="(/GyanD/codexffmpeg/releases/download/[^"]+/ffmpeg-[^"]+-essentials_build\.zip)"') {
            $assetPath = $Matches[1]
            foreach ($proxy in $GithubProxyMirrors) {
                $urls.Add(("$proxy" + "https://github.com" + $assetPath))
            }
            $urls.Add("https://github.com" + $assetPath)
        }
    }
    catch {
        Write-WarnMessage "The gyan GitHub release page could not be resolved; that source will be skipped."
    }
    return $urls
}

function Install-PortableFFmpeg {
    # Download order: official sources first (BtbN stable rolling build + gyan.dev,
    # they work well with a proxy or direct access), then GitHub accelerator proxies
    # that mirror the BtbN asset, then GitHub direct as a final fallback.
    # Proxies are speed-tested first so the fastest one is tried first.
    $archive = Join-Path $env:TEMP "pixelle-ffmpeg.zip"
    $btbnAsset = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"

    $orderedProxies = Get-OrderedMirrors -CacheKey "github-proxy" -Mirrors $GithubProxyMirrors -Label "GitHub proxy" -SampleUrlBuilder ${function:Get-GithubProxySampleUrl}
    $urls = New-Object System.Collections.Generic.List[string]
    # 1) Official direct sources first (resolve the gyan release asset for its stable file name).
    foreach ($url in (Resolve-GyanReleaseAssetUrls)) {
        $urls.Add($url)
    }
    $urls.Add($btbnAsset)
    $urls.Add("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip")
    # 2) GitHub accelerator proxies as a backup for direct access failures.
    foreach ($proxy in $orderedProxies) {
        $urls.Add("$proxy$btbnAsset")
    }

    Invoke-Download -Urls $urls -Destination $archive -MinimumBytes 30000000 -Retries 1 -TimeoutSeconds 300 -Verifier { param($p) Test-FFmpegArchive $p }

    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $extractRoot = Join-Path $ToolsRoot "ffmpeg-extract"
    $targetRoot = Join-Path $ToolsRoot "ffmpeg"
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    if (Test-Path -LiteralPath $targetRoot) { Remove-Item -LiteralPath $targetRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null

    Write-Host "  Extracting the FFmpeg archive..."
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extractRoot)

    $ffmpeg = Get-ChildItem -LiteralPath $extractRoot -Filter ffmpeg.exe -File -Recurse | Select-Object -First 1
    $ffprobe = Get-ChildItem -LiteralPath $extractRoot -Filter ffprobe.exe -File -Recurse | Select-Object -First 1
    if (-not $ffmpeg -or -not $ffprobe) { throw "FFmpeg archive is incomplete." }

    $binRoot = Join-Path $targetRoot "bin"
    New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
    Copy-Item -LiteralPath $ffmpeg.FullName -Destination (Join-Path $binRoot "ffmpeg.exe")
    Copy-Item -LiteralPath $ffprobe.FullName -Destination (Join-Path $binRoot "ffprobe.exe")

    $ffmpegVersion = Invoke-CapturedProcess (Join-Path $binRoot "ffmpeg.exe") "-version" 10
    if ($ffmpegVersion -notmatch "ffmpeg version") {
        throw "The downloaded ffmpeg.exe cannot run. It may have been blocked by antivirus software."
    }
    $ffprobeVersion = Invoke-CapturedProcess (Join-Path $binRoot "ffprobe.exe") "-version" 10
    if ($ffprobeVersion -notmatch "ffprobe version") {
        throw "The downloaded ffprobe.exe cannot run. It may have been blocked by antivirus software."
    }

    Remove-Item -LiteralPath $extractRoot -Recurse -Force
    Add-ProcessPath $binRoot
    Write-Ok "FFmpeg installed to $binRoot"
}

function Get-DependencyFingerprint {
    param([string[]]$Paths)
    $items = foreach ($path in $Paths) {
        if (Test-Path -LiteralPath $path) {
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        }
    }
    return ($items -join "-")
}

function Test-State {
    param([string]$Name, [string]$Fingerprint)
    $path = Join-Path $StateRoot $Name
    return ((Test-Path -LiteralPath $path) -and ((Get-Content -LiteralPath $path -Raw).Trim() -eq $Fingerprint))
}

function Set-State {
    param([string]$Name, [string]$Fingerprint)
    Set-Content -LiteralPath (Join-Path $StateRoot $Name) -Value $Fingerprint -Encoding ASCII
}

function Install-PythonProject {
    param([string]$VenvPython)
    $fingerprint = Get-DependencyFingerprint @(
        (Join-Path $ProjectRoot "pyproject.toml"),
        (Join-Path $ProjectRoot "uv.lock")
    )
    if (-not $ForceInstall -and (Test-State "python-dependencies.txt" $fingerprint)) {
        if ((Invoke-PythonCode -PythonPath $VenvPython -Code "import fastapi, playwright, pixelle_video") -eq 0) {
            Write-Ok "Python dependencies are already up to date."
            return
        }
        Write-WarnMessage "The dependency marker exists, but an import check failed. Reinstalling."
    }

    $orderedMirrors = Get-OrderedMirrors -CacheKey "pip" -Mirrors $PipMirrors -Label "Python package" -SampleUrlBuilder ${function:Get-PipSampleUrl}
    foreach ($mirror in $orderedMirrors) {
        try {
            Write-Host "  Trying Python package source: $mirror"
            & $VenvPython -m pip install --disable-pip-version-check --retries 2 --timeout 45 --index-url $mirror --upgrade pip setuptools wheel
            if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed" }
            & $VenvPython -m pip install --disable-pip-version-check --retries 2 --timeout 60 --index-url $mirror --editable $ProjectRoot
            if ($LASTEXITCODE -ne 0) { throw "project dependency installation failed" }
            Set-State "python-dependencies.txt" $fingerprint
            Write-Ok "Python dependencies installed from $mirror"
            return
        }
        catch {
            Write-WarnMessage ("Python source failed: {0}" -f $_.Exception.Message)
        }
    }
    throw "All Python package sources failed. See the messages above."
}

function Install-NodeProject {
    param([string]$Directory, [string]$StateName, [string]$NpmCommand)
    $fingerprint = Get-DependencyFingerprint @(
        (Join-Path $Directory "package.json"),
        (Join-Path $Directory "package-lock.json")
    )
    if (-not $ForceInstall -and (Test-State $StateName $fingerprint) -and (Test-Path -LiteralPath (Join-Path $Directory "node_modules"))) {
        Write-Ok "Node dependencies are already up to date: $Directory"
        return
    }

    $orderedRegistries = Get-OrderedMirrors -CacheKey "npm" -Mirrors $NpmMirrors -Label "npm registry" -SampleUrlBuilder ${function:Get-NpmSampleUrl}
    foreach ($mirror in $orderedRegistries) {
        Write-Host "  Trying npm registry: $mirror"
        Push-Location $Directory
        try {
            & $NpmCommand ci "--registry=$mirror" --replace-registry-host=always --fetch-retries=2 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=15000 --fetch-timeout=120000 --no-audit --no-fund
            if ($LASTEXITCODE -eq 0) {
                Set-State $StateName $fingerprint
                Write-Ok "Node dependencies installed from $mirror"
                return
            }
            Write-WarnMessage "npm exited with code $LASTEXITCODE"
        }
        catch {
            Write-WarnMessage ("npm source failed: {0}" -f $_.Exception.Message)
        }
        finally {
            Pop-Location
        }
        # 失败后清掉半成品 node_modules，避免残留文件锁定干扰下一个源。
        $nodeModules = Join-Path $Directory "node_modules"
        if (Test-Path -LiteralPath $nodeModules) {
            Write-Host "  Cleaning the incomplete node_modules before the next source..."
            attrib -R (Join-Path $nodeModules "*") /S /D 2>$null
            Remove-Item -LiteralPath $nodeModules -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    throw "All npm registries failed for $Directory."
}

function Find-PlaywrightChromium {
    # Playwright 的浏览器安装路径是固定的：%LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win64\chrome.exe
    # 直接按文件系统查找，避免用 Python 探测（严格模式下 -c 传参/stderr 干扰等问题太多）。
    $pattern = Join-Path $env:LOCALAPPDATA "ms-playwright\chromium-*\chrome-win64\chrome.exe"
    $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if ($found) { return $found }
    return $null
}

function Install-PlaywrightBrowser {
    param([string]$VenvPython)
    $browserPath = Find-PlaywrightChromium
    if ($browserPath) {
        return $browserPath
    }

    $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = "120000"
    foreach ($mirror in $PlaywrightMirrors) {
        if ($mirror) {
            $env:PLAYWRIGHT_DOWNLOAD_HOST = $mirror
            Write-Host "  Trying Playwright browser source: $mirror"
        }
        else {
            Remove-Item Env:PLAYWRIGHT_DOWNLOAD_HOST -ErrorAction SilentlyContinue
            Write-Host "  Trying the official Playwright download source..."
        }
        # playwright install 的进度输出走 stderr，严格模式会误判为致命错误；用与依赖校验相同的临时放开模式。
        $installExitCode = (Invoke-PythonCode -PythonPath $VenvPython -Code "import sys; from playwright.__main__ import main; sys.argv=['playwright','install','chromium']; main()")
        if ($installExitCode -eq 0) {
            $resolvedBrowser = Find-PlaywrightChromium
            if ($resolvedBrowser) {
                $browserPath = $resolvedBrowser
                Remove-Item Env:PLAYWRIGHT_DOWNLOAD_HOST -ErrorAction SilentlyContinue
                Write-Ok "Chromium installed to $browserPath"
                return $browserPath
            }
        }
        Write-WarnMessage "Playwright browser download failed; trying the next source."
    }
    throw "All Playwright browser download sources failed."
}

function Test-Url {
    param([string]$Url, [string]$ExpectedText = "")
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) { return $false }
        if ($ExpectedText -and $response.Content -notlike "*$ExpectedText*") { return $false }
        return $true
    }
    catch { return $false }
}

function Wait-ForUrl {
    param([string]$Url, [int]$Seconds, [string]$Name, [string]$ExpectedText = "")
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Url $Url $ExpectedText) {
            Write-Ok "$Name is ready: $Url"
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "$Name did not become ready in $Seconds seconds. Check the service logs under $ToolsRoot (especially the *-stderr.log file)."
}

function ConvertTo-CmdArgument {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    # The generated command files are UTF-8 and run with delayed expansion off.
    # Doubling percent signs prevents a project path containing '%' from being
    # interpreted as an environment-variable expansion by cmd.exe.
    $escaped = $Value.Replace('%', '%%')
    if ($escaped -notmatch '[\s"&<>^|()]') { return $escaped }
    return '"' + $escaped + '"'
}

function ConvertTo-CmdSetLine {
    param([string]$Name, [AllowNull()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    $escaped = $Value.Replace('%', '%%').Replace('"', '""')
    return ('set "{0}={1}"' -f $Name, $escaped)
}

function Start-DetachedProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment,
        [string]$CommandFileName,
        [string]$PidFileName,
        [string]$StdoutPath,
        [string]$StderrPath
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw ("{0} executable was not found: {1}" -f $Name, $FilePath)
    }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
        throw ("{0} working directory was not found: {1}" -f $Name, $WorkingDirectory)
    }

    foreach ($path in @($StdoutPath, $StderrPath)) {
        $parent = Split-Path -Parent $path
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    }

    # Do not launch a nested PowerShell window here.  Some hosted/remote
    # Windows desktops (including UU cloud PCs) reject that ShellExecute call
    # with 0xffffffff.  A hidden cmd wrapper started through .NET's
    # UseShellExecute=false works in both interactive and restricted sessions,
    # preserves the exact working directory, and keeps service logs on disk.
    $commandFile = Join-Path $ToolsRoot $CommandFileName
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('@echo off')
    $lines.Add('setlocal DisableDelayedExpansion')
    $lines.Add('chcp 65001 >nul')
    $lines.Add(('cd /d {0}' -f (ConvertTo-CmdArgument $WorkingDirectory)))
    foreach ($key in $Environment.Keys) {
        $lines.Add((ConvertTo-CmdSetLine $key ([string]$Environment[$key])))
    }
    $commandParts = @((ConvertTo-CmdArgument $FilePath))
    foreach ($argument in $Arguments) {
        $commandParts += ConvertTo-CmdArgument ([string]$argument)
    }
    $commandLine = (($commandParts -join ' ') + (' >> {0} 2>> {1}' -f (ConvertTo-CmdArgument $StdoutPath), (ConvertTo-CmdArgument $StderrPath)))
    $lines.Add($commandLine)
    $lines.Add('exit /b %errorlevel%')
    # Windows PowerShell 5.1 writes a BOM for -Encoding UTF8. A BOM before
    # @echo can make legacy cmd.exe reject the first command, so write UTF-8
    # without BOM while retaining non-ASCII project paths.
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($commandFile, $lines, $utf8WithoutBom)

    $cmdPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
    if (-not (Test-Path -LiteralPath $cmdPath -PathType Leaf)) {
        throw ("Windows command interpreter was not found: {0}" -f $cmdPath)
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $cmdPath
    $startInfo.Arguments = ('/d /c call {0}' -f (ConvertTo-CmdArgument $commandFile))
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
        if ($null -eq $process) {
            throw 'Process.Start returned no process.'
        }
        Add-Content -LiteralPath $LogFile -Value (
            "[{0}] Started {1} in background (pid={2}; stdout={3}; stderr={4})" -f
            (Get-Date -Format s), $Name, $process.Id, $StdoutPath, $StderrPath
        ) -Encoding UTF8
        if ($PidFileName) {
            Set-Content -LiteralPath (Join-Path $ToolsRoot $PidFileName) -Value $process.Id -Encoding ASCII
        }
        Write-Ok ("{0} started in background (logs: {1}, {2})" -f $Name, $StdoutPath, $StderrPath)
        return $process.Id
    }
    catch {
        throw ("Could not start {0}. CommandFile={1}; WorkingDirectory={2}; {3}" -f $Name, $commandFile, $WorkingDirectory, $_.Exception.Message)
    }
}

Disable-ConsoleQuickEdit

try {
    if ([Environment]::Is64BitOperatingSystem -ne $true) {
        throw "Pixelle Video requires 64-bit Windows 10 or Windows 11."
    }

    New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    Set-Content -LiteralPath $LogFile -Value ("Pixelle Video Windows startup - {0}" -f (Get-Date)) -Encoding UTF8
    Refresh-ProcessPath

    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " Pixelle Video - first-time setup and one-click launcher" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "Project: $ProjectRoot"

    Write-Step 1 "Checking Python 3.11 or newer"
    $Python = Find-Python
    if (-not $Python) {
        [void](Install-WithWinget "Python.Python.3.12" "Python 3.12")
        $Python = Find-Python
    }
    if (-not $Python) {
        Install-PythonFallback
        $Python = Find-Python
    }
    if (-not $Python) { throw "Python installation completed but python.exe could not be found. Restart Windows and retry." }
    Write-Ok ("Python: {0} ({1})" -f $Python, (& $Python --version))

    Write-Step 2 "Checking Node.js 22 or newer"
    $Node = Find-Node
    if (-not $Node) {
        [void](Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS")
        $Node = Find-Node
    }
    if (-not $Node) {
        Install-PortableNode
        $Node = Find-Node
    }
    if (-not $Node) { throw "Node.js installation completed but node.exe could not be found." }
    $NodeDirectory = Split-Path $Node -Parent
    Add-ProcessPath $NodeDirectory
    $Npm = Join-Path $NodeDirectory "npm.cmd"
    if (-not (Test-Path -LiteralPath $Npm)) { throw "npm.cmd was not found next to Node.js." }
    Write-Ok ("Node.js: {0}" -f (& $Node --version))

    Write-Step 3 "Checking FFmpeg and FFprobe"
    $FFmpegDirectory = Find-FFmpegDirectory
    if (-not $FFmpegDirectory) {
        Write-WarnMessage "No working FFmpeg found. Downloading a portable build (domestic mirrors first)."
        Install-PortableFFmpeg
        $FFmpegDirectory = Find-FFmpegDirectory
    }
    if (-not $FFmpegDirectory) {
        Write-WarnMessage "The portable mirror download failed; trying the Windows Package Manager as a fallback."
        [void](Install-WithWinget "Gyan.FFmpeg" "FFmpeg")
        $FFmpegDirectory = Find-FFmpegDirectory
    }
    if (-not $FFmpegDirectory) { throw "FFmpeg could not be installed." }
    Add-ProcessPath $FFmpegDirectory
    Write-Ok "FFmpeg and FFprobe are available."

    Write-Step 4 "Creating the isolated Python virtual environment"
    $VenvRoot = Join-Path $ProjectRoot ".venv-windows"
    $VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $VenvPython)) {
        Invoke-Checked $Python @("-m", "venv", $VenvRoot) "Could not create the Python virtual environment"
    }
    if (-not (Test-Path -LiteralPath $VenvPython)) { throw "The virtual environment python.exe is missing." }
    Write-Ok "Virtual environment: $VenvRoot"

    Write-Step 5 "Installing Python dependencies with automatic mirror retry"
    Install-PythonProject $VenvPython

    Write-Step 6 "Installing Node.js dependencies with automatic mirror retry"
    Install-NodeProject (Join-Path $ProjectRoot "studio") "studio-dependencies.txt" $Npm
    Install-NodeProject (Join-Path $ProjectRoot "services\hyperframes-renderer") "renderer-dependencies.txt" $Npm

    Write-Step 7 "Installing the Chromium browser used for frame rendering"
    $BrowserPath = Install-PlaywrightBrowser $VenvPython
    Write-Ok "Chromium: $BrowserPath"

    Write-Step 8 "Preparing safe local configuration files"
    $config = Join-Path $ProjectRoot "config.yaml"
    if (-not (Test-Path -LiteralPath $config)) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot "config.example.yaml") -Destination $config
        Write-Ok "Created config.yaml from the example."
    }
    else { Write-Ok "Existing config.yaml was kept unchanged." }

    $studioEnv = Join-Path $ProjectRoot "studio\.env.local"
    if (-not (Test-Path -LiteralPath $studioEnv)) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot "studio\.env.example") -Destination $studioEnv
        Write-Ok "Created studio/.env.local from the example."
    }
    else { Write-Ok "Existing studio/.env.local was kept unchanged." }

    Write-Step 9 "Starting Pixelle Video"

    $apiPort = Get-ConfiguredPort -EnvironmentName "PIXELLE_API_PORT" -DefaultPort $DefaultApiPort
    $apiUrl = "http://127.0.0.1:$apiPort"
    if (-not (Test-Url "$apiUrl/health" "Pixelle-Video API")) {
        if (-not (Test-PortAvailable $apiPort)) {
            $oldApiPort = $apiPort
            $apiPort = Find-FreePort -StartingPort ($apiPort + 1) -ServiceName "Pixelle Video API"
            $apiUrl = "http://127.0.0.1:$apiPort"
            Write-WarnMessage ("API port {0} is occupied; using {1}." -f $oldApiPort, $apiPort)
        }
        Start-DetachedProcess `
            -Name "Pixelle Video - API" `
            -FilePath $VenvPython `
            -Arguments @("api/app.py", "--host", "127.0.0.1", "--port", [string]$apiPort) `
            -WorkingDirectory $ProjectRoot `
            -Environment @{
                PIXELLE_API_PORT = [string]$apiPort
                PYTHONUTF8 = "1"
                PYTHONIOENCODING = "utf-8"
                HYPERFRAMES_BROWSER_PATH = $BrowserPath
            } `
            -CommandFileName "api-start.cmd" `
            -PidFileName "api.pid" `
            -StdoutPath (Join-Path $ToolsRoot "api-stdout.log") `
            -StderrPath (Join-Path $ToolsRoot "api-stderr.log") | Out-Null
        Wait-ForUrl "$apiUrl/health" 90 "API" "Pixelle-Video API"
    }
    else { Write-Ok ("API is already running at {0}." -f $apiUrl) }

    $studioPort = Get-ConfiguredPort -EnvironmentName "PIXELLE_STUDIO_PORT" -DefaultPort $DefaultStudioPort
    if ($studioPort -eq $apiPort) {
        $studioPort = Find-FreePort -StartingPort ($studioPort + 1) -ServiceName "Pixelle Production Studio"
        Write-WarnMessage ("Studio port matched the API port; using {0}." -f $studioPort)
    }
    $studioUrl = "http://127.0.0.1:$studioPort"
    if (-not (Test-Url $studioUrl "Pixelle Production Desk")) {
        if (-not (Test-PortAvailable $studioPort)) {
            $oldStudioPort = $studioPort
            $studioPort = Find-FreePort -StartingPort ($studioPort + 1) -ServiceName "Pixelle Production Studio"
            $studioUrl = "http://127.0.0.1:$studioPort"
            Write-WarnMessage ("Studio port {0} is occupied; using {1}." -f $oldStudioPort, $studioPort)
        }
        $nextCliPath = Join-Path $ProjectRoot "studio\node_modules\next\dist\bin\next"
        if (-not (Test-Path -LiteralPath $nextCliPath -PathType Leaf)) {
            throw "Next.js CLI was not found at $nextCliPath. Re-run the dependency installation step."
        }
        $studioDirectory = Join-Path $ProjectRoot "studio"
        Start-DetachedProcess `
            -Name "Pixelle Video - Studio" `
            -FilePath $Node `
            -Arguments @($nextCliPath, "dev", "--hostname", "127.0.0.1", "--port", [string]$studioPort) `
            -WorkingDirectory $studioDirectory `
            -Environment @{
                PORT = [string]$studioPort
                PIXELLE_API_URL = $apiUrl
            } `
            -CommandFileName "studio-start.cmd" `
            -PidFileName "studio.pid" `
            -StdoutPath (Join-Path $ToolsRoot "studio-stdout.log") `
            -StderrPath (Join-Path $ToolsRoot "studio-stderr.log") | Out-Null
        Wait-ForUrl $studioUrl 180 "Studio" "Pixelle Production Desk"
    }
    else { Write-Ok ("Studio is already running at {0}." -f $studioUrl) }

    if ($StartRunner) {
        Write-WarnMessage "-StartRunner is no longer needed. Use the Continuous Production switch in Studio."
    }

    if (-not $NoBrowser) {
        try {
            Start-Process -FilePath $studioUrl -ErrorAction Stop | Out-Null
        }
        catch {
            # A headless/locked-down cloud desktop may not expose a default
            # browser to ShellExecute.  Services are already running, so an
            # inability to open the browser must not turn a successful startup
            # into a setup failure; print the URL for manual opening instead.
            Write-WarnMessage ("Could not open the browser automatically: {0}" -f $_.Exception.Message)
            Write-Host ("        Open this URL manually: {0}" -f $studioUrl)
        }
    }

    Write-Host ""
    Write-Host "Pixelle Video is ready." -ForegroundColor Green
    Write-Host ("Studio:   {0}" -f $studioUrl)
    Write-Host ("API docs: {0}/docs" -f $apiUrl)
    Write-Host "Ports can be overridden with PIXELLE_API_PORT and PIXELLE_STUDIO_PORT."
    Write-Host ("Service logs: {0}" -f $ToolsRoot)
    Write-Host "Continuous production is controlled by the switch in Studio."
    Write-Host "API and Studio run in the background; close their processes or rerun the launcher after stopping them."
    exit 0
}
catch {
    $message = $_.Exception.Message
    Write-Host ""
    Write-Host "SETUP FAILED: $message" -ForegroundColor Red
    Add-Content -LiteralPath $LogFile -Value ("FAILED: {0}`r`n{1}" -f $message, $_.ScriptStackTrace) -Encoding UTF8
    Write-Host "Log file: $LogFile"
    Write-Host "Fix the reported issue, then double-click the launcher again. Completed steps will be reused."
    exit 1
}
