<#
  Qwen3-ASR-1.7B 一键部署脚本
  做四件事：准备内置 Python -> 装 PyTorch(CUDA) 与 qwen-asr -> 下模型 -> 冒烟测试。
  可重复运行：已完成的步骤会自动跳过。
#>
[CmdletBinding()]
param(
    [int]$Port = 8010,
    [string]$HfMirror = 'https://hf-mirror.com',
    [string]$PipIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple/',
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cu128',
    [switch]$SkipModel,
    [switch]$NoStart,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# 不主动把输出编码改成 UTF-8：PS 5.1 + chcp 65001 会把中日韩字符重复显示一遍。
# 交回控制台默认代码页（中文系统 936），脚本文件本身仍是 UTF-8 带 BOM。
try { [Console]::OutputEncoding = [Text.Encoding]::Default } catch { }

$Root      = Split-Path -Parent $PSScriptRoot
$PyDir     = Join-Path $Root 'py'
$ModelsDir = Join-Path $Root 'models'
$LogsDir   = Join-Path $Root 'logs'
$DownDir   = Join-Path $Root 'download'
$PyExe     = Join-Path $PyDir 'python.exe'

# 镜像列表：第一个是默认源，后面是备选。哪个快用哪个，慢到 150 KB/s 以下会自动换。
$PipMirrors = @(
    $PipIndex,
    'https://mirrors.aliyun.com/pypi/simple/',
    'https://mirrors.ustc.edu.cn/pypi/simple/',
    'https://repo.huaweicloud.com/repository/pypi/simple/',
    'https://pypi.org/simple'
) | Select-Object -Unique

$ModelRepo = 'Qwen/Qwen3-ASR-1.7B'
$ModelName = 'Qwen3-ASR-1.7B'
$PkgSpec   = 'qwen-asr==0.0.6'
# protobuf：transformers 的 fast tokenizer 回退到 slow 时必须有它，
# 缺了会在“启动加载 tokenizer”那一步直接 ImportError（实测踩过）
$PkgSpecs  = @($PkgSpec, 'protobuf')
$MinDiskGB = 14

function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Die ($m) { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

# 人类可读的大小
function Format-Size([double]$bytes) {
    if ($bytes -ge 1073741824) { return ('{0:N2} GB' -f ($bytes / 1073741824)) }
    if ($bytes -ge 1048576)    { return ('{0:N0} MB' -f ($bytes / 1048576)) }
    return ('{0:N0} KB' -f ($bytes / 1024))
}

# 人类可读的时长（秒）。超过一天不再算精确值，避免 Int32 溢出
function Format-Dur([double]$sec) {
    if ($sec -lt 0) { return '--:--' }
    if ($sec -gt 86400) { return '>1 天' }
    $s = [long][math]::Round($sec)
    return ('{0:00}:{1:00}' -f [int]($s / 60), [int]($s % 60))
}

# 调用内置 Python 的统一入口。
# 坑：PS 5.1 在 $ErrorActionPreference='Stop' 下，会把原生程序写到 stderr 的内容当成
# 终止错误（torch 一条 "Failed to initialize NumPy" 的 UserWarning 就让整个安装脚本崩了）。
# 所以这里临时把 EAP 降成 Continue，把 stderr 并进输出，只返回退出码。
function Invoke-Py {
    param([string[]]$PyArgs, [switch]$Quiet)
    # 两个坑叠在一起：
    #   1) PS 5.1 在 EAP=Stop 下会把原生程序写 stderr 的内容当成终止错误；
    #   2) 只重定向 stderr（2>file / 2>$null）仍会生成 NativeCommandError 记录。
    # 解法：把 EAP 临时降成 Continue，再用 2>&1 + ForEach-Object "$_" 把错误记录
    # 变成普通字符串，这样既不会中断，也不会往控制台喷红色错误块。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $PyExe @PyArgs 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        $text = ($lines -join "`n")
        if (-not $Quiet -and $text.Trim()) { Write-Host $text.TrimEnd() }
        return [pscustomobject]@{ Code = $code; Out = $text }
    } finally {
        $ErrorActionPreference = $prev
    }
}

# 会长时间的调用（pip 装 torch / 业务包）用它：输出边跑边打印，屏幕上能一直看到
# pip 自己的下载进度，不会像 Invoke-Py 那样全吞到结束才吐出来。
function Invoke-PyLive {
    param([string[]]$PyArgs, [int]$KeepLast = 15)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $tail = New-Object System.Collections.ArrayList
    $code = 0
    try {
        & $PyExe @PyArgs 2>&1 | ForEach-Object {
            # stderr 会被 PS 包成 ErrorRecord，直接 "$_" 会打出一串类型名，取消息本体
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
            Write-Host $line
            [void]$tail.Add($line)
            if ($tail.Count -gt $KeepLast) { $tail.RemoveAt(0) }
        }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    } finally {
        $ErrorActionPreference = $prev
    }
    return [pscustomobject]@{ Code = $code; Tail = ($tail -join "`n") }
}

# 用 HEAD 拿远端真实大小（镜像大小会变，不写死）；拿不到就返回 0，跳过大小校验
function Get-RemoteSize([string]$Url) {
    $h = & curl.exe -sIL --fail --ssl-no-revoke --max-time 20 $Url 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $h) { return 0 }
    $len = 0
    foreach ($line in $h) {
        if ($line -match '^\s*content-length:\s*(\d+)\s*$') { $len = [int64]$Matches[1] }
    }
    return $len
}
# 带进度条的下载：curl 在后台跑，前台每 800ms 读目标文件大小画条。
# 45 秒没有增长就判定断流并杀掉，交给上层换源。
function Invoke-Download {
    param([string]$Url, [string]$Dest, [int64]$Expected, [string]$Label, [int]$MinKBps = 0, [int]$SlowAfterSec = 12)

    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    if ($DryRun) {
        Write-Host ("    [DryRun] 将下载 {0}" -f $Url)
        return [pscustomobject]@{ Ok = $true; Code = 0 }
    }

    # 断点续传：真正的下载写进 .part，成功后改名。
    # 这样大文件被中断（断网、服务端掐连接、关机）之后，重跑能接着下。
    $part = "$Dest.part"
    if (Test-Path $Dest) { Remove-Item $Dest -Force -ErrorAction SilentlyContinue }

    # 单行原地刷新：帧长必须夹在控制台宽度以内，否则会折行，\r 回不到同一行
    $width = 100
    try { if ([Console]::WindowWidth -gt 0) { $width = [Console]::WindowWidth - 1 } } catch { }
    if ($width -lt 40) { $width = 40 }
    $redirected = $false
    try { $redirected = [Console]::IsOutputRedirected } catch { }

    # 18 = 传输被对端掐断，56/92 = 连接重置，7 = 连不上，28 = 超时。
    # 这些大多是服务端抖动，用 -C - 续传重试基本都能接上；404(22) 之类不重试，交给上层换源。
    # 33 = 服务端不支持 Range 续传（改用从头重下，见下面的 attempt 前置处理）；35 = TLS/吊销检查抖动
    $retryable = @(18, 56, 92, 7, 28, 33, 35)
    $code = 0
    $err = ''
    $maxAttempt = 8

    $attemptStartBytes = [int64]0
    # 小文件卡 45 秒太久，20 秒就换一次连接；大文件给足耐心
    $stallLimit = if ($Expected -gt 0 -and $Expected -lt 1048576) { 20 } else { 45 }
    $stallCount = 0
    for ($attempt = 1; $attempt -le $maxAttempt; $attempt++) {
        # 0 字节的 .part 会让 curl 发 Range: bytes=0- ，个别 CDN 会挂住，先清掉
        if ((Test-Path $part) -and ((Get-Item $part).Length -eq 0)) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
        if (Test-Path $part) { $attemptStartBytes = (Get-Item $part).Length }
        if ($attempt -gt 1) {
            $have = 0
            if (Test-Path $part) { $have = (Get-Item $part).Length }
            if ($code -eq 33) {
                # 服务端不支持断点续传，带 -C - 只会一直报 33，必须删掉半截文件从头下
                if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
                Warn ("服务端不支持续传（curl 33），丢掉已下的 {0}，从头重下…" -f (Format-Size $have))
            } elseif ($code -eq -2) {
                Warn ("连接卡住，第 {0}/{1} 次重试（已下 {2}）…" -f $attempt, $maxAttempt, (Format-Size $have))
            } else {
                Warn ("传输中断（curl {0}），已下 {1}，第 {2}/{3} 次续传…" -f $code, (Format-Size $have), $attempt, $maxAttempt)
            }
            Start-Sleep -Seconds 2
        }

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'curl.exe'
        # --ssl-no-revoke 必须带：这台机器做不了证书吊销检查，schannel 会报 CRYPT_E_NO_REVOCATION_CHECK(35)
        # 小文件（<1 MB）不走续传：HF 镜像的 CDN 实测不认 Range（发 Range 也回 200 + 整个文件），
        # 带 -C - 只会拿到 curl 33，还得重来一遍，不如直接从头下。
        $resumeArg = ''
        if ($Expected -eq 0 -or $Expected -ge 1048576) { $resumeArg = ' -C -' }
        $psi.Arguments = '-L --fail -sS --ssl-no-revoke --connect-timeout 20' + $resumeArg + ' -o "' + $part + '" "' + $Url + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardOutput = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $lastBytes = [int64]-1
        $lastGrow = [double]0
        $stalled = $false
        $slow = $false
        $lastDrawn = ''
        $lastRedirPct = -10
        $winStart = [double]0
        $winBytes = [int64]0
        $speed = [double]0

        while (-not $proc.HasExited) {
            Start-Sleep -Milliseconds 300
            $cur = 0
            if (Test-Path $part) { $cur = (Get-Item $part).Length }
            $sec = [double]$sw.Elapsed.TotalSeconds
            if ($cur -gt $lastBytes) { $lastBytes = $cur; $lastGrow = $sec }

            if (($sec - $lastGrow) -gt $stallLimit) { $stalled = $true; try { $proc.Kill() } catch { }; break }

            # 太慢就放弃只对小文件生效：torch 这种 2.67 GB 一旦掐掉就是几十分钟白跑
            if ($MinKBps -gt 0 -and $Expected -lt 314572800 -and $sec -ge $SlowAfterSec -and $cur -gt 1048576 -and $speed -lt ($MinKBps * 1024)) {
                $slow = $true; try { $proc.Kill() } catch { }; break
            }

            # 近 1.2 秒滑动平均速度
            if (($sec - $winStart) -ge 1.2) {
                $speed = ($cur - $winBytes) / [math]::Max(0.3, ($sec - $winStart))
                $winStart = $sec; $winBytes = $cur
            }
            if ($speed -le 0 -and $sec -gt 0.3) { $speed = $cur / $sec }

            if ($Expected -gt 0) {
                $pct = [int][math]::Floor($cur * 100 / $Expected)
                if ($pct -gt 100) { $pct = 100 }
                $barW = 24
                $fill = [int]($barW * $pct / 100); if ($fill -gt $barW) { $fill = $barW }
                $bar = ('#' * $fill) + ('-' * ($barW - $fill))
                $eta = -1
                if ($speed -gt 20480) { $eta = ($Expected - $cur) / $speed }
                $line = "  [{0}] {1,3}%  {2} / {3}  {4}/s  ETA {5}" -f $bar, $pct,
                        (Format-Size $cur), (Format-Size $Expected), (Format-Size $speed), (Format-Dur $eta)

                if ($redirected) {
                    if (($pct - $lastRedirPct) -ge 10 -or $pct -ge 100) { $lastRedirPct = $pct; Write-Host $line }
                } elseif ($line -ne $lastDrawn) {
                    $lastDrawn = $line
                    if ($line.Length -ge $width) { $line = $line.Substring(0, $width) }
                    [Console]::Write("`r" + $line.PadRight($width))
                }
            } else {
                $line = "  已下载 {0}  {1}/s" -f (Format-Size $cur), (Format-Size $speed)
                if (-not $redirected -and $line -ne $lastDrawn) {
                    $lastDrawn = $line
                    [Console]::Write("`r" + $line.PadRight([math]::Min($width, 44)))
                }
            }
        }

        if (-not $redirected) { try { [Console]::Write("`r" + (' ' * $width) + "`r") } catch { } }

        $proc.WaitForExit()
        $code = $proc.ExitCode
        $err = $proc.StandardError.ReadToEnd()

        if ($stalled) {
            $stallCount++
            Warn ("连接卡住（{0} 秒没有新数据），第 {1}/{2} 次重试…" -f $stallLimit, $attempt, $maxAttempt)
            if ($stallCount -ge 3) {
                Warn '连续三次卡住，这个源对这个文件不可用'
                return [pscustomobject]@{ Ok = $false; Code = -2; Err = 'stalled' }
            }
            Start-Sleep -Seconds 1
            continue
        }
        if ($slow) { return [pscustomobject]@{ Ok = $false; Code = -4; Err = 'too-slow' } }
        if ($code -eq 0) { break }
        if ($retryable -notcontains $code) { break }

        # 只要这一轮确实下到了新数据，就不算"尝试次数"——服务端每次只给一小段也能最终下完；
        # 反过来，连续几轮一个字节都没拿到，就真的该放弃了。
        $nowBytes = 0
        if (Test-Path $part) { $nowBytes = (Get-Item $part).Length }
        if (($nowBytes - $attemptStartBytes) -gt 262144) { $attempt-- }
    }

    if ($code -ne 0) {
        if ($err) { Warn ('curl: ' + (($err -split "`n")[0]).Trim()) }
        return [pscustomobject]@{ Ok = $false; Code = $code; Err = $err }
    }

    if (Test-Path $part) { Move-Item $part $Dest -Force }
    if ($Expected -gt 0 -and (Test-Path $Dest)) {
        $got = (Get-Item $Dest).Length
        if ($got -ne $Expected) {
            Warn ("大小不对：期望 {0}，实得 {1}" -f (Format-Size $Expected), (Format-Size $got))
            return [pscustomobject]@{ Ok = $false; Code = -3; Err = 'size' }
        }
    }
    Ok ("下载完成 {0}" -f (Format-Size (Get-Item $Dest).Length))
    return [pscustomobject]@{ Ok = $true; Code = 0 }
}
# 多源依次尝试，第一个成功就返回
function Invoke-Mirrors {
    param([object[]]$Sources, [string]$Dest, [int64]$Expected, [string]$Label)
    $i = 0
    $r = $null
    foreach ($s in $Sources) {
        $i++
        Info ("[{0}/{1}] 源：{2}" -f $i, $Sources.Count, $s.Name)
        $r = Invoke-Download -Url $s.Url -Dest $Dest -Expected $Expected -Label $Label
        if ($r.Ok) { return $r }
        Warn ("这个源不行（exit {0}），换下一个…" -f $r.Code)
    }
    return $r
}

# ---------------------------------------------------------------- 0. 环境自检
Info ("目标目录：{0}" -f $Root)
Write-Host ''
Info '检查环境…'
if (-not [Environment]::Is64BitOperatingSystem) { Die '需要 64 位 Windows' }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Die '找不到 curl.exe（Windows 10 1803 以上自带）' }
Write-Host ("    {0,-10}{1}" -f 'curl.exe', '可用')

$osv = [Environment]::OSVersion.Version
if ($osv.Major -lt 10) { Die ("需要 Windows 10 或更高，当前 {0}" -f $osv) }
Write-Host ("    {0,-10}{1}" -f 'Windows', ("{0}.{1}（64 位）" -f $osv.Major, $osv.Build))

$smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if (-not $smi) { Die '没找到 nvidia-smi，请先装 NVIDIA 驱动' }
$gpu = & nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader 2>$null
if ($LASTEXITCODE -ne 0 -or -not $gpu) { Die 'nvidia-smi 读不到显卡信息' }
$gpu = ($gpu | Select-Object -First 1).Trim()
Write-Host ("    {0,-10}{1}" -f '显卡', $gpu)

$free = [math]::Round((Get-PSDrive ($Root.Substring(0,1))).Free / 1GB, 1)
Write-Host ("    {0,-10}{1}" -f '磁盘', ("{0} GB 可用" -f $free))
if ($free -lt $MinDiskGB -and -not $Force) {
    Die ("需要至少 {0} GB 空闲（Python + PyTorch + 模型），当前 {1} GB" -f $MinDiskGB, $free)
}

foreach ($d in @($PyDir, $ModelsDir, $LogsDir, $DownDir)) {
    if (-not (Test-Path $d) -and -not $DryRun) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# 全程留痕：装完/装炸都能在 logs\ 里找到这次运行的完整输出，
# 排查时不用截图（PS 5.1 的 Start-Transcript 在部分终端会报错，所以包 try）
$transcript = $null
if (-not $DryRun) {
    try {
        $transcript = Join-Path $LogsDir ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Start-Transcript -Path $transcript -Force | Out-Null
    } catch { $transcript = $null }
}

# ---------------------------------------------------------------- 1. 内置 Python
Write-Host ''
if (Test-Path $PyExe) {
    $v = (Invoke-Py @('-c', "import sys;print('%d.%d.%d' % sys.version_info[:3])") -Quiet).Out.Trim()
    Ok ("Python 已就绪：{0}" -f $v)
} else {
    Info '准备内置 Python 3.11（约 11 MB）…'
    $zipName = 'python-3.11.9-embed-amd64.zip'
    $zipPath = Join-Path $DownDir $zipName
    $srcs = @(
        [pscustomobject]@{ Name = '华为云镜像'; Url = "https://mirrors.huaweicloud.com/python/3.11.9/$zipName" },
        [pscustomobject]@{ Name = 'npmmirror'; Url = "https://registry.npmmirror.com/-/binary/python/3.11.9/$zipName" },
        [pscustomobject]@{ Name = '阿里云镜像'; Url = "https://mirrors.aliyun.com/python-release/windows/$zipName" },
        [pscustomobject]@{ Name = 'python.org';  Url = "https://www.python.org/ftp/python/3.11.9/$zipName" }
    )
    $zipSize = Get-RemoteSize $srcs[0].Url
    if ($zipSize -gt 0) { Info ("Python 包大小：{0}" -f (Format-Size $zipSize)) }
    $r = Invoke-Mirrors $srcs $zipPath $zipSize 'Python'
    if (-not $r.Ok) { Die 'Python 下载失败，请检查网络后重跑' }

    if (-not $DryRun) {
        Info '解压…'
        Expand-Archive -Path $zipPath -DestinationPath $PyDir -Force
        # 嵌入版默认不加载 site-packages，要改写 ._pth 才能 pip 装包
        $pth = Get-ChildItem $PyDir -Filter 'python*._pth' | Select-Object -First 1
        if ($pth) {
            $lines = @('python311.zip', '.', 'Lib\site-packages', 'import site')
            [IO.File]::WriteAllLines($pth.FullName, $lines, (New-Object Text.UTF8Encoding($false)))
        }
        Ok '解压完成'
    }
}

if (-not $DryRun) {
    $hasPip = $false
    if ((Invoke-Py @('-m','pip','--version') -Quiet).Code -eq 0) { $hasPip = $true }
    if (-not $hasPip) {
        Info '安装 pip…'
        $getpip = Join-Path $DownDir 'get-pip.py'
        $srcs = @([pscustomobject]@{ Name = 'bootstrap.pypa.io'; Url = 'https://bootstrap.pypa.io/get-pip.py' })
        $gpSize = Get-RemoteSize $srcs[0].Url
        $r = Invoke-Mirrors $srcs $getpip $gpSize 'get-pip'
        if (-not $r.Ok) { Die 'get-pip.py 下载失败' }
        $gp = Invoke-PyLive @($getpip, '--no-warn-script-location', '-i', $PipIndex)
        if ($gp.Code -ne 0) { Die 'pip 安装失败' }
    }
    $pipv = (Invoke-Py @('-m','pip','--version') -Quiet).Out.Trim()
    Ok ("pip 就绪：{0}" -f $pipv)
}

# pip 自己的进度条在管道里会退化成一行动也不动的 "Downloading …"，肉眼完全看不出在动。
# 办法：先用 --dry-run --report 让 pip 只做依赖解析（不下载），拿到每个 wheel 的直链；
# 再用 curl 逐个下（我们自己的字节级进度条），最后 --no-index 离线安装。
# 这样 torch 那个 2.86 GB 的大包也能看到实时速度和百分比。
function Invoke-PyWatch {
    param([string[]]$PyArgs, [int]$Seconds = 180)

    # 和 Invoke-Py 一样收集输出，但会每隔 5 秒报一次"还在跑"：
    # pip 解析依赖时一个字都不打，90 秒的静默看起来就像卡死（实测清华源就要 90 秒）。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $PyExe
    # 含空格的参数要加引号；参数内部的引号要转义，否则 -c "print(1)" 这种会被拆坏
    $psi.Arguments = ($PyArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $next = 5
        while (-not $proc.HasExited) {
            Start-Sleep -Milliseconds 400
            $s = [int]$sw.Elapsed.TotalSeconds
            if ($s -ge $Seconds) {
                try { $proc.Kill() } catch { }
                return [pscustomobject]@{ Code = -9; Out = "解析超时（$Seconds 秒），已中止" }
            }
            if ($s -ge $next) {
                $next += 5
                Write-Host ("    还在跑… 已 {0}s" -f $s) -ForegroundColor DarkGray
            }
        }
        $proc.WaitForExit()
        $out = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd()
        return [pscustomobject]@{ Code = $proc.ExitCode; Out = $out }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Invoke-PipGetWheels {
    param([string[]]$Specs, [string[]]$IndexArgs, [string]$Dest)

    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $rep = Join-Path $env:TEMP ('piprep-' + [guid]::NewGuid().ToString('N') + '.json')
    # --timeout 10 --retries 0：解析阶段只是问"有哪些包"，不该在死源上无限等
    $r = Invoke-PyWatch -PyArgs (@('-m','pip','install','--dry-run','--no-cache-dir','--ignore-installed','--timeout','10','--retries','0','--report',$rep) + $IndexArgs + $Specs) -Seconds 180
    if ($r.Code -ne 0) {
        Remove-Item $rep -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Ok = $false; Code = $r.Code; Tail = $r.Out }
    }
    $items = @()
    try { $items = @((Get-Content $rep -Raw -Encoding UTF8 | ConvertFrom-Json).install) } catch { }
    Remove-Item $rep -Force -ErrorAction SilentlyContinue
    if ($items.Count -eq 0) { return [pscustomobject]@{ Ok = $false; Code = -1; Tail = '依赖解析没返回任何包' } }

    Info ("依赖解析完成：共 {0} 个包" -f $items.Count)
    $i = 0
    foreach ($it in $items) {
        $i++
        $u = $it.download_info.url
        $file = Split-Path $u -Leaf
        # 注意：$dest 与参数 $Dest 是同一个变量（PowerShell 不区分大小写），
        # 这里必须另起名字，否则第二轮起会把文件名拼到上一个文件路径后面。
        $destPath = Join-Path $Dest $file
        if ((Test-Path $destPath) -and (Get-Item $destPath).Length -gt 0) {
            Ok ("[{0}/{1}] {2} 已存在" -f $i, $items.Count, $file)
            continue
        }
        $size = Get-RemoteSize $u
        Info ("[{0}/{1}] {2}  {3}" -f $i, $items.Count, $file, (Format-Size $size))
        $dl = Invoke-Download -Url $u -Dest $destPath -Expected $size -Label $file -MinKBps 150 -SlowAfterSec 12
        if (-not $dl.Ok) { return [pscustomobject]@{ Ok = $false; Code = $dl.Code; Tail = ("下载 {0} 失败（{1}）" -f $file, $dl.Err) } }
    }
    return [pscustomobject]@{ Ok = $true; Code = 0; Tail = '' }
}

# 依次尝试多个 PyPI 镜像：某个镜像慢到不可用（Invoke-Download 会中途放弃）就换下一个。
# 目的：numpy / torch 这类大文件在国内不同镜像速度能差 100 倍，写死一个源就会"卡很久"。
function Invoke-PipGetWheelsAny {
    param([string[]]$Specs, [string]$Dest, [string[]]$Mirrors)

    $last = $null
    $i = 0
    foreach ($m in $Mirrors) {
        $i++
        Info ("[{0}/{1}] PyPI 源：{2}" -f $i, $Mirrors.Count, $m)
        $last = Invoke-PipGetWheels -Specs $Specs -IndexArgs @('-i', $m) -Dest $Dest
        if ($last.Ok) { return $last }
        Warn ("这个源不行（{0}），换下一个" -f $last.Code)
    }
    return $last
}

# 先装 numpy：torch 2.9 不再强依赖它，但导入时会尝试初始化，缺了会刷一堆 UserWarning
if (-not $DryRun) {
    if ((Invoke-Py @('-c','import numpy') -Quiet).Code -ne 0) {
        Info '安装 numpy…'
        $npWheels = Join-Path $DownDir 'wheels-numpy'
        $nf = Invoke-PipGetWheelsAny -Specs @('numpy') -Dest $npWheels -Mirrors $PipMirrors
        if ($nf.Ok) {
            $nr = Invoke-PyLive @('-m','pip','install','--no-cache-dir','--no-index','--find-links',$npWheels,'numpy')
        } else {
            $nr = [pscustomobject]@{ Code = 1 }
        }
        if ($nr.Code -eq 0) { Ok 'numpy 就绪' } else { Warn 'numpy 安装失败（不影响继续，后面装业务包时可能带进来）' }
    } else { Ok 'numpy 已就绪' }
}

# ---------------------------------------------------------------- 2. PyTorch
Write-Host ''
Info '安装 PyTorch（CUDA 12.8 版，约 2.5 GB，首次会比较久）…'
if (-not $DryRun) {
    $hasTorch = $false
    $chk = Invoke-Py @('-c','import torch;print(torch.__version__)') -Quiet
    if ($chk.Code -eq 0) { $hasTorch = $true; Ok ("PyTorch 已安装：{0}" -f $chk.Out.Trim()) }
    if ((-not $hasTorch) -or $Force) {
        # 这里有两个坑，都是踩过的：
        # 1) --index-url 只能出现一次（-i 就是它的缩写，后写的会覆盖前面的）→ 依赖源必须用 --extra-index-url
        # 2) PyPI 上有版本号更高的 CPU 版 torch（如 2.14.1），不锁 +cu128 的本地版本号，pip 会挑那个
        $torchPins = @('torch==2.9.1+cu128', 'torchaudio==2.9.1+cu128')
        $wheelDir = Join-Path $DownDir 'wheels-torch'
        $cp = 'cp311-cp311-win_amd64'
        $need = @(
            [pscustomobject]@{ Url = ("torch-2.9.1%2Bcu128-{0}.whl" -f $cp);      Local = ("torch-2.9.1+cu128-{0}.whl" -f $cp) },
            [pscustomobject]@{ Url = ("torchaudio-2.9.1%2Bcu128-{0}.whl" -f $cp); Local = ("torchaudio-2.9.1+cu128-{0}.whl" -f $cp) }
        )
        # 直接拼 wheel 地址，不走 pip 解析：PyPI 上的 CPU 版版本号更高，走解析很容易被带到 CPU 版；
        # 而且各镜像的索引结构不一致（阿里云的 pytorch-wheels 里根本没有 +cu128 版本）。
        $bases = @(
            [pscustomobject]@{ Name = '官方 PyTorch'; Base = 'https://download.pytorch.org/whl/cu128' },
            [pscustomobject]@{ Name = '南大镜像';     Base = 'https://mirrors.nju.edu.cn/pytorch/whl/cu128' },
            [pscustomobject]@{ Name = '上交镜像';     Base = 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128' },
            [pscustomobject]@{ Name = '清华镜像';     Base = 'https://mirrors.tuna.tsinghua.edu.cn/pytorch/whl/cu128' }
        )
        $got = $false
        foreach ($b in $bases) {
            Info ("下载 PyTorch wheel（源 {0}）" -f $b.Name)
            $okAll = $true
            $k = 0
            foreach ($w in $need) {
                $k++
                $u = $b.Base + '/' + $w.Url
                $dst = Join-Path $wheelDir $w.Local
                if ($DryRun) { Write-Host ("    [DryRun] 将下载 {0}" -f $u); continue }
                $size = Get-RemoteSize $u
                if ($size -le 0) { Warn ("这个源上没有 {0}" -f $w.Local); $okAll = $false; break }
                # 已经下好的就别再下一遍（2.67 GB 重下一次代价太大）
                if ((Test-Path $dst) -and (Get-Item $dst).Length -eq $size) {
                    Ok ("[{0}/{1}] {2} 已存在" -f $k, $need.Count, $w.Local)
                    continue
                }
                Info ("[{0}/{1}] {2}  {3}" -f $k, $need.Count, $w.Local, (Format-Size $size))
                $dl = Invoke-Download -Url $u -Dest $dst -Expected $size -Label $w.Local
                if (-not $dl.Ok) { Warn ("下载失败（exit {0}）" -f $dl.Code); $okAll = $false; break }
            }
            if ($okAll) { $got = $true; break }
            Warn '这个源没成功，换下一个'
        }
        if (-not $got) { Die 'PyTorch wheel 下载失败，请把上面的报错发我' }
        # torch 的依赖（filelock / sympy / networkx / jinja2 / fsspec / typing-extensions / setuptools）
        # 不在 --no-index 的本地目录里，会报 "No matching distribution found for filelock"。
        # 先把它们也下进同一个目录，安装时才能真正离线。
        Info '准备 PyTorch 的依赖…'
        $torchDeps = @('filelock','typing-extensions','sympy','networkx','jinja2','fsspec','setuptools','mpmath','MarkupSafe')
        $df = Invoke-PipGetWheelsAny -Specs $torchDeps -Dest $wheelDir -Mirrors $PipMirrors
        if ($df.Ok) { Ok '依赖已就绪' } else { Warn '依赖没预下载成功，安装时改走在线源补齐' }

        Info '安装 PyTorch（离线优先）…'
        if ($df.Ok) {
            $ti = Invoke-PyLive (@('-m','pip','install','--no-cache-dir','--no-index','--find-links',$wheelDir) + $torchPins)
        } else {
            $ti = Invoke-PyLive (@('-m','pip','install','--no-cache-dir','--find-links',$wheelDir,'--extra-index-url',$PipIndex) + $torchPins)
        }
        if ($ti.Code -ne 0) { Die 'PyTorch 安装失败（wheel 已下好，可加 -Force 重试）' }
        # 装的是不是 CUDA 版，装完立刻验，别等到跑模型才发现是 CPU 版
        $cudaOk = (Invoke-Py @('-c','import torch;print(torch.cuda.is_available())') -Quiet).Out.Trim()
        if ("$cudaOk".Trim() -eq 'True') { Ok 'PyTorch 安装完成（CUDA 可用）' }
        else { Warn 'PyTorch 装上了，但 torch.cuda.is_available() 不是 True —— 可能装成了 CPU 版，或者驱动有问题' }
    }
}

# ---------------------------------------------------------------- 3. 业务包
Write-Host ''
Info ("安装 {0}…" -f ($PkgSpecs -join ' '))
if (-not $DryRun) {
    # 业务包的依赖树很大（transformers / torchaudio / onnxruntime / gradio …），
    # 先 dry-run 解析再自己下 wheel，在慢镜像上要几分钟（实测清华 92 秒起，冷缓存能超 180 秒被我们掐掉）。
    # 这里直接交给 pip：它自己下、自己重试，输出朴素但一直是活的。
    $pi = $null
    foreach ($m in $PipMirrors) {
        Info ("尝试 PyPI 源：{0}" -f $m)
        $pi = Invoke-PyLive (@('-m','pip','install','--no-cache-dir','--timeout','20','--retries','2','-i',$m) + $PkgSpecs)
        if ($pi.Code -eq 0) { break }
        Warn ("这个源没装上（exit {0}），换下一个" -f $pi.Code)
    }
    if ($pi.Code -ne 0) { Die ("{0} 安装失败：所有源都试过了，把上面的报错发我" -f $PkgSpec) }
    $qi = Invoke-Py @('-c','import qwen_asr') -Quiet
    if ($qi.Code -ne 0) { Die 'qwen_asr 导入失败，请把上面的报错发我' }
    Ok 'qwen-asr 安装完成'
}

# ---------------------------------------------------------------- 4. 模型
Write-Host ''
$modelDir = Join-Path $ModelsDir $ModelName
if ($SkipModel) {
    Warn '按 -SkipModel 跳过模型下载'
} elseif ((Test-Path (Join-Path $modelDir 'config.json')) -and -not $Force) {
    $sz = (Get-ChildItem $modelDir -Recurse -File | Measure-Object Length -Sum).Sum
    Ok ("模型已存在：{0}（{1}）" -f $modelDir, (Format-Size $sz))
} else {
    Info ("下载模型 {0}（约 4.4 GB）…" -f $ModelRepo)
    if (-not $DryRun) {
        # 模型源按优先级排：ModelScope（国内直连，实测 5 MB/s）→ HF 镜像 → HuggingFace 官方
        $files = @()
        $srcs  = @()

        Info '取模型文件清单…'
        $msApi = "https://modelscope.cn/api/v1/models/$ModelRepo/repo/files?Revision=master"
        $json = & curl.exe -sL --fail --ssl-no-revoke --max-time 30 $msApi
        if ($LASTEXITCODE -eq 0 -and $json) {
            try {
                $ms = $json | ConvertFrom-Json
                $files = @($ms.Data.Files | Where-Object { $_.Path -ne '.gitattributes' } |
                           ForEach-Object { [pscustomobject]@{ rfilename = $_.Path; size = [int64]$_.Size } })
                if ($files.Count -gt 0) {
                    $srcs += [pscustomobject]@{ Name = 'ModelScope'; Base = "https://modelscope.cn/models/$ModelRepo/resolve/master" }
                    Ok ("清单来自 ModelScope，{0} 个文件" -f $files.Count)
                }
            } catch { $files = @() }
        }
        if ($files.Count -eq 0) {
            $api = "$HfMirror/api/models/$ModelRepo" + '?blobs=true'
            $json = & curl.exe -sL --fail --ssl-no-revoke --max-time 30 $api
            if ($LASTEXITCODE -ne 0 -or -not $json) { Die '取不到模型文件清单（网络不通？），请重跑' }
            $meta = $json | ConvertFrom-Json
            $files = @($meta.siblings | Where-Object { $_.rfilename -ne '.gitattributes' })
            if ($files.Count -eq 0) { Die '模型文件清单是空的' }
            Ok ("清单来自 HF 镜像，{0} 个文件" -f $files.Count)
        }
        $srcs += [pscustomobject]@{ Name = 'HF镜像'; Base = "$HfMirror/$ModelRepo/resolve/main" }
        $srcs += [pscustomobject]@{ Name = 'HuggingFace'; Base = "https://huggingface.co/$ModelRepo/resolve/main" }

        if (-not (Test-Path $modelDir)) { New-Item -ItemType Directory -Force -Path $modelDir | Out-Null }

        $total = 0
        foreach ($f in $files) { $total += [int64]$f.size }
        Info ("共 {0} 个文件，{1}" -f $files.Count, (Format-Size $total))

        $i = 0
        foreach ($f in $files) {
            $i++
            $rel = $f.rfilename -replace '/', '\'
            $dest = Join-Path $modelDir $rel
            Info ("[{0}/{1}] {2}  {3}" -f $i, $files.Count, $f.rfilename, (Format-Size $f.size))
            $url = $null
            $r   = $null
            # 挨个源试；某个源掐连接就换下一个（ModelScope 通常第一个就成）
            foreach ($s in $srcs) {
                $url = "$($s.Base)/$($f.rfilename)"
                $r = Invoke-Download -Url $url -Dest $dest -Expected ([int64]$f.size) -Label $f.rfilename
                if ($r.Ok) { break }
                Warn ("{0} 不行（exit {1}），换下一个源…" -f $s.Name, $r.Code)
            }
            if (-not $r.Ok) {
                # 诊断落盘：exit 码 + 两个源 + .part 实际大小，下次直接看这个文件
                $partInfo = '无 .part'
                if (Test-Path "$dest.part") { $partInfo = ('{0:N0} 字节' -f (Get-Item "$dest.part").Length) }
                $diag = ("{0}  文件={1}  exit={2}  期望={3:N0}  已下={4}  镜像={5}" -f `
                    (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $f.rfilename, $r.Code, [int64]$f.size, $partInfo, $url)
                try { Add-Content -Path (Join-Path $LogsDir 'download-error.txt') -Value $diag -Encoding UTF8 } catch { }
                Die ("下载失败：{0}（exit {1}），重跑本脚本可续传；诊断已写入 logs\download-error.txt" -f $f.rfilename, $r.Code)
            }
        }
        # 收尾校验：逐文件核对大小。短了/少了就立刻报错，
        # 否则会在“启动时 tokenizer 找不到 vocab.json”这种地方才炸
        $bad = @()
        foreach ($f in $files) {
            $rel  = $f.rfilename -replace '/', '\'
            $chk  = Join-Path $modelDir $rel
            if (-not (Test-Path $chk)) { $bad += ("   缺文件: {0}" -f $f.rfilename); continue }
            $have = (Get-Item $chk).Length
            if ([int64]$f.size -gt 0 -and $have -ne [int64]$f.size) {
                $bad += ("   大小不符: {0}  期望 {1}  实际 {2}" -f $f.rfilename, (Format-Size $f.size), (Format-Size $have))
            }
        }
        if ($bad.Count -gt 0) {
            Write-Host ($bad -join "`n") -ForegroundColor Yellow
            Die ("模型文件不完整（{0} 项）。删掉对应的 .part 后重跑本脚本" -f $bad.Count)
        }
        Ok '模型文件校验通过'
    }
}

# ---------------------------------------------------------------- 5. 冒烟测试
Write-Host ''
Info '冒烟测试…'
if (-not $DryRun) {
    $code = @'
import torch
print("torch", torch.__version__, "cuda", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu", torch.cuda.get_device_name(0))
import qwen_asr
print("qwen_asr ok")
'@
    $tmpPy = Join-Path $LogsDir 'smoke.py'
    [IO.File]::WriteAllText($tmpPy, $code, (New-Object Text.UTF8Encoding($false)))
    $sm = Invoke-Py @($tmpPy)
    if ($sm.Code -ne 0) { Warn '冒烟测试有报错，见上面输出' }
}

# ---------------------------------------------------------------- 6. 收尾
Write-Host ''
if ($transcript) { try { Stop-Transcript | Out-Null } catch { } }
Ok '安装完成'
Write-Host ("    Python : {0}" -f $PyExe)
Write-Host ("    模型   : {0}" -f $modelDir)
Write-Host ("    启动   : 双击 start.bat（默认 http://127.0.0.1:{0}）" -f $Port)
if ($DryRun) {
    Info '[DryRun] 跳过启动'
} elseif (-not $NoStart) {
    Write-Host ''
    Info '现在启动服务…'
    $serve = Join-Path $PSScriptRoot 'serve.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serve -Port $Port
}
