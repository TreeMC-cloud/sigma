# Sigma 屏幕采集 —— 持续输出 JPEG 帧到 stdout
#
# 为什么用 PowerShell 而不是 Node 直接截图：
#   Node 没有内置的屏幕捕获能力，要做就得编译 node-addon 或者依赖原生模块，
#   而客户端的设计前提是「零依赖、单文件 exe」。PowerShell 在所有 Windows 上
#   都自带，.NET 的 System.Drawing 能直接抓屏。
#
# 为什么是**常驻进程**而不是每次调用：
#   每次起一个 PowerShell 进程要 200-400ms，最多 3 帧/秒；
#   常驻循环能达到 10-15 帧/秒，这才是「视频」而不是「幻灯片」。
#
# 输出协议：每帧前打印 `--FRAME <字节数>`，然后写原始 JPEG 字节。
#   用长度前缀而不是分隔符：JPEG 数据里什么字节都可能有，
#   分隔符会被误判，长度前缀不会。

param(
  [int]$Fps = 12,
  [int]$Quality = 55,
    [double]$Scale = 1.0   # 默认原尺寸。缩一半时 2560x1288 会变成 1280x644，
                        # 在手机小窗里看着糊；而且用户会觉得「只显示了部分」
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

# ⚠ DPI 感知必须在读取屏幕尺寸**之前**声明。
#
# 不声明的话，进程是「DPI  unaware」的：Windows 会给它一个缩放过、
# 虚拟的坐标系。150% 缩放下，1920x1080 的屏幕会被报成 1280x720，
# 于是 CopyFromScreen 只抓到左上角那一块 —— 真机上就是
# 「小窗只显示电脑左上角」。这个 bug 和 input.ps1 里那个是同一个根因，
# 但只在采集侧表现成「画面不全」。
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SigmaDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@ -ErrorAction SilentlyContinue
} catch { }

try { [void][SigmaDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) }
catch { try { [void][SigmaDpi]::SetProcessDPIAware() } catch { } }

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$srcW = $bounds.Width
$srcH = $bounds.Height

# ⚠ 兜底：从显卡驱动直接读物理分辨率。
#
# 真机实测（2560x1288 的屏、200% 缩放）：
#   即使调了 SetProcessDpiAwarenessContext(-4)，
#   SystemInformation.VirtualScreen 仍然只报 1280x644 —— 正好一半。
# 结果 CopyFromScreen 只抓到屏幕左上角 1/4 的面积。
#
# Win32_VideoController 的 CurrentHorizontalResolution 是驱动层的真实值，
# 不受进程 DPI 影响。两个值不一致就以它为准。
try {
  $vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
        Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object -First 1
  if ($vc -and $vc.CurrentHorizontalResolution -gt $srcW) {
    $srcW = [int]$vc.CurrentHorizontalResolution
    $srcH = [int]$vc.CurrentVerticalResolution
    # 边界也要跟着改：VirtualScreen 的 X/Y 在缩放环境下通常是 0
    $bounds = New-Object System.Drawing.Rectangle(0, 0, $srcW, $srcH)
  }
} catch { /* 查询失败就用 VirtualScreen 的值 */ }
$dstW = [int]($srcW * $Scale)
$dstH = [int]($srcH * $Scale)

$bmp = New-Object System.Drawing.Bitmap($srcW, $srcH)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$small = New-Object System.Drawing.Bitmap($dstW, $dstH)
$smallGfx = [System.Drawing.Graphics]::FromImage($small)
$smallGfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

# 告诉父进程「我准备好了」，附上真实分辨率
# 同时报「采集尺寸」和「屏幕物理尺寸」，两者不相等就说明 DPI 没生效
[Console]::Out.WriteLine("--READY $dstW $dstH $Fps $srcW $srcH")
[Console]::Out.Flush()

$stdout = [Console]::OpenStandardOutput()
$interval = [int](1000 / [Math]::Max(1, $Fps))

while ($true) {
  $t0 = [Environment]::TickCount

  try {
    $gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
    $smallGfx.DrawImage($bmp, 0, 0, $dstW, $dstH)

    $ms = New-Object System.IO.MemoryStream
    $small.Save($ms, $codec, $ep)
    $bytes = $ms.ToArray()
    $ms.Dispose()

    $header = [Text.Encoding]::ASCII.GetBytes("--FRAME $($bytes.Length)`n")
    $stdout.Write($header, 0, $header.Length)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
  } catch {
    # 锁屏、UAC 提权界面、切换用户时会抓不到画面。
    # 报告一次错误但继续跑：用户解锁后画面会自动恢复。
    $msg = [Text.Encoding]::ASCII.GetBytes("--ERROR $($_.Exception.Message)`n")
    $stdout.Write($msg, 0, $msg.Length)
    $stdout.Flush()
  }

  # 按目标帧率补齐间隔，避免抓多快就发多快（那会占满 CPU）
  $elapsed = [Environment]::TickCount - $t0
  $sleep = $interval - $elapsed
  if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}
