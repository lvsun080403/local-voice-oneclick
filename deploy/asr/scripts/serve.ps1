<#
  Qwen3-ASR-1.7B 启停脚本
  用法（一般由 start.bat / stop.bat / status.bat 调用）：
    serve.ps1            # 后台启动并打印地址
    serve.ps1 -Foreground # 前台运行（Ctrl+C 结束）
    serve.ps1 -Status     # 看状态
    serve.ps1 -Stop       # 停止
#>
[CmdletBinding()]
param(
    [int]$Port = 8010,
    [string]$Listen = '127.0.0.1',
    [switch]$Background,
    [switch]$Foreground,
    [switch]$Status,
    [switch]$Stop,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
# 不主动改 UTF-8：PS 5.1 + chcp 65001 会把中日韩字符重复显示。
try { [Console]::OutputEncoding = [Text.Encoding]::Default } catch { }

$Root    = Split-Path -Parent $PSScriptRoot
$PyExe   = Join-Path $Root 'py\python.exe'
$Model   = Join-Path $Root 'models\Qwen3-ASR-1.7B'
$LogsDir = Join-Path $Root 'logs'
$PidFile = Join-Path $Root 'asr.pid'
$BaseUrl = "http://{0}:{1}" -f $Listen, $Port

function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Bad ($m) { Write-Host "[x] $m" -ForegroundColor Red }

# 用 curl 拿 HTTP 状态码，2 秒超时，失败返回 000
function Get-Http([string]$Url) {
    $out = & curl.exe -s --noproxy '*' -o NUL -w '%{http_code}' -m 2 $Url 2>$null
    if ($null -eq $out) { return '000' }
    return "$out".Trim()
}

# 找出监听该端口的进程号（netstat 最后一段）
function Get-PortPid([int]$p) {
    $lines = & netstat.exe -ano -p TCP 2>$null
    foreach ($l in $lines) {
        if ($l -match "LISTENING" -and $l -match (":$p\s")) {
            $parts = ($l.Trim() -split '\s+')
            return [int]$parts[$parts.Count - 1]
        }
    }
    return 0
}

# 杀掉一个进程树；taskkill 没权限时退回 Stop-Process
function Kill-Pid([int]$procId) {
    if (-not $procId) { return $false }
    & taskkill.exe /PID $procId /T /F *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; return $true } catch { return $false }
}

# ---------------------------------------------------------------- 状态
if ($Status) {
    $code = Get-Http "$BaseUrl/"
    $procId = Get-PortPid $Port
    if ($code -eq '200' -or $code -eq '302') {
        Ok '运行中'
        Write-Host ("    地址 : {0}" -f $BaseUrl)
        Write-Host ("    模型 : {0}" -f $Model)
        if ($procId) { Write-Host ("    PID  : {0}" -f $procId) }
        exit 0
    }
    if ($procId) {
        Warn ("端口 {0} 有进程（PID {1}），但 HTTP 还没起来（可能正在加载模型）" -f $Port, $procId)
        exit 1
    }
    Warn '未运行'
    exit 1
}

# ---------------------------------------------------------------- 停止
if ($Stop) {
    $procId = Get-PortPid $Port
    if ($procId) {
        if (Kill-Pid $procId) { Ok ("已停止（PID {0}）" -f $procId) }
        else { Bad ("停不掉（PID {0}），试试以管理员身份运行 stop.bat" -f $procId) }
    } else {
        Ok '本来就没有在运行'
    }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
    exit 0
}

# ---------------------------------------------------------------- 启动前检查
if (-not (Test-Path $PyExe)) { Bad ("找不到 Python：{0}`n    先双击 install.bat" -f $PyExe); exit 1 }
if (-not (Test-Path (Join-Path $Model 'config.json'))) {
    Bad ("找不到模型：{0}`n    先双击 install.bat（或把模型解压到 models\Qwen3-ASR-1.7B）" -f $Model)
    exit 1
}
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null }

$code = Get-Http "$BaseUrl/"
if ($code -eq '200') {
    Ok ("服务已经在运行：{0}" -f $BaseUrl)
    if (-not $NoBrowser) { Start-Process $BaseUrl | Out-Null }
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogsDir "asr-$stamp.out.log"
$errLog = Join-Path $LogsDir "asr-$stamp.err.log"

# 传给 qwen-asr-demo 的参数
$pyArgs = @(
    '-m', 'qwen_asr.cli.demo',
    '--asr-checkpoint', $Model,
    '--ip', $Listen,
    '--port', "$Port"
)

Info '拉起服务（首次加载模型约 10–40 秒）…'

if ($Foreground) {
    Info ("{0} {1}" -f $PyExe, ($pyArgs -join ' '))
    & $PyExe @pyArgs
    exit $LASTEXITCODE
}

$p = Start-Process -FilePath $PyExe -ArgumentList $pyArgs -WorkingDirectory $Root `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content -Path $PidFile -Value $p.Id -Encoding ASCII

$sw = [Diagnostics.Stopwatch]::StartNew()
$ready = $false
while ($sw.Elapsed.TotalSeconds -lt 180) {
    if ($p.HasExited) { break }
    $code = Get-Http "$BaseUrl/"
    if ($code -eq '200' -or $code -eq '302') { $ready = $true; break }
    Start-Sleep -Seconds 2
}

if (-not $ready) {
    Bad '没起来。最后 20 行日志：'
    if (Test-Path $errLog) { Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host "    $_" } }
    if (Test-Path $outLog) { Get-Content $outLog -Tail 20 | ForEach-Object { Write-Host "    $_" } }
    exit 1
}

Ok '就绪'
Write-Host ("    Base URL : {0}" -f $BaseUrl)
Write-Host ("    模型     : Qwen3-ASR-1.7B")
Write-Host ("    PID      : {0}" -f $p.Id)
Write-Host ("    日志     : {0}" -f $errLog)
if (-not $NoBrowser) { Start-Process $BaseUrl | Out-Null }
