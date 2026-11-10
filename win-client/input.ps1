# Sigma 输入控制 —— 鼠标与键盘
#
# 为什么用 PowerShell 而不是 Node 原生模块：
#   客户端的设计前提是「零依赖、单文件 exe」。SendInput/SetCursorPos 是
#   user32.dll 里的 C 接口，Node 调不到；PowerShell 用 Add-Type 编译一小段
#   P/Invoke 声明就能调，而且所有 Windows 都自带 PowerShell。
#
# 为什么每次调用起一个进程：
#   鼠标点击是低频事件（人手操作），不像屏幕采集要连续跑。
#   起进程约 200-400ms，对人机交互完全够用；常驻进程反而要维护 IPC 协议。
#
# 用法（参数形式）：
#   powershell -File input.ps1 -Action move -X 100 -Y 200
#   powershell -File input.ps1 -Action click -Button left
#   powershell -File input.ps1 -Action type -Text "你好"
#   powershell -File input.ps1 -Action key -Keys "CTRL+V"
#   powershell -File input.ps1 -Action scroll -Delta -3
#   powershell -File input.ps1 -Action screen      # 返回屏幕尺寸

param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Button = 'left',
  [string]$Text = '',
  [string]$Keys = '',
  [int]$Delta = 0,
  [int]$MoveMs = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

if (-not ('SigmaInput' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SigmaInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800, HWHEEL = 0x1000;
  public const uint KEYUP = 0x0002;
}
'@
}

# ⚠ DPI 感知必须在**任何**坐标相关调用之前设置。
# 高分屏 125%/150% 缩放下，不声明的进程拿到的是「逻辑像素」，
# 而我们算坐标用的是截图的物理像素——两边差一截，点击就会偏。
# PER_MONITOR_AWARE_V2 = -4；失败就退回旧 API（老系统）。
try { [void][SigmaInput]::SetProcessDpiAwarenessContext([IntPtr](-4)) }
catch { try { [void][SigmaInput]::SetProcessDPIAware() } catch { } }

$si = [SigmaInput]

switch ($Action) {

  'screen' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    "{`"ok`":true,`"width`":$($b.Width),`"height`":$($b.Height),`"x`":$($b.X),`"y`":$($b.Y)}"
  }

  'pos' {
    $p = New-Object SigmaInput+POINT
    [void][SigmaInput]::GetCursorPos([ref]$p)
    "{`"ok`":true,`"x`":$($p.X),`"y`":$($p.Y)}"
  }

  'move' {
    # MoveMs > 0 时做平滑移动：很多程序（游戏、画板）只认连续移动事件，
    # 瞬移会被忽略或当成拖拽。
    if ($MoveMs -gt 0) {
      $p = New-Object SigmaInput+POINT
      [void][SigmaInput]::GetCursorPos([ref]$p)
      $steps = [Math]::Max(6, [int]($MoveMs / 12))
      for ($i = 1; $i -le $steps; $i++) {
        $nx = [int]($p.X + ($X - $p.X) * $i / $steps)
        $ny = [int]($p.Y + ($Y - $p.Y) * $i / $steps)
        [void][SigmaInput]::SetCursorPos($nx, $ny)
        Start-Sleep -Milliseconds ([Math]::Max(1, [int]($MoveMs / $steps)))
      }
    }
    [void][SigmaInput]::SetCursorPos($X, $Y)
    "{`"ok`":true,`"x`":$X,`"y`":$Y}"
  }

  'click' {
    $down = $si::LEFTDOWN; $up = $si::LEFTUP
    if ($Button -eq 'right')  { $down = $si::RIGHTDOWN;  $up = $si::RIGHTUP }
    if ($Button -eq 'middle') { $down = $si::MIDDLEDOWN; $up = $si::MIDDLEUP }
    [void][SigmaInput]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 40
    [SigmaInput]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [SigmaInput]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
    "{`"ok`":true,`"button`":`"$Button`",`"x`":$X,`"y`":$Y}"
  }

  'dblclick' {
    [void][SigmaInput]::SetCursorPos($X, $Y)
    for ($i = 0; $i -lt 2; $i++) {
      [SigmaInput]::mouse_event($si::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      [SigmaInput]::mouse_event($si::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    "{`"ok`":true}"
  }

  'down' {
    [SigmaInput]::mouse_event($si::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    "{`"ok`":true}"
  }

  'up' {
    [SigmaInput]::mouse_event($si::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    "{`"ok`":true}"
  }

  'scroll' {
    # Delta 单位是「格」，正数向上。Windows 的 wheel 参数是 120 的倍数。
    [SigmaInput]::mouse_event($si::WHEEL, 0, 0, ($Delta * 120), [IntPtr]::Zero)
    "{`"ok`":true,`"delta`":$Delta}"
  }

  'type' {
    # 中文必须走 SendKeys 的剪贴板外路径 —— 直接用 VkKeyScan 只能打英文。
    # SendKeys 支持一部分 Unicode，但慢；对中文更可靠的是先写剪贴板再 Ctrl+V。
    if ($Text -match '[^\x00-\x7F]') {
      Set-Clipboard -Value $Text
      Start-Sleep -Milliseconds 120
      [System.Windows.Forms.SendKeys]::SendWait('^v')
    } else {
      [System.Windows.Forms.SendKeys]::SendWait($Text)
    }
    "{`"ok`":true,`"len`":$($Text.Length)}"
  }

  'key' {
    # 支持 "CTRL+V"、"ENTER"、"ALT+TAB" 这种组合
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    "{`"ok`":true,`"keys`":`"$Keys`"}"
  }

  'keydown' {
    # 按下不松（长按用）。必须配 'keyup' 或看门狗释放，
    # 否则 Ctrl/Alt 卡住会让整个系统没法用。
    $map = @{
      'ctrl'=0x11; 'alt'=0x12; 'shift'=0x10; 'win'=0x5B
      'tab'=0x09; 'esc'=0x1B; 'enter'=0x0D; 'space'=0x20
      'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27
    }
    $k = $Keys.ToLower()
    if (-not $map.ContainsKey($k)) { "{`"ok`":false,`"error`":`"不支持的键: $Keys`"}"; exit 1 }
    [SigmaInput]::keybd_event([byte]$map[$k], 0, 0, [IntPtr]::Zero)
    "{`"ok`":true,`"held`":`"$k`"}"
  }

  'keyup' {
    $map = @{
      'ctrl'=0x11; 'alt'=0x12; 'shift'=0x10; 'win'=0x5B
      'tab'=0x09; 'esc'=0x1B; 'enter'=0x0D; 'space'=0x20
      'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27
    }
    $k = $Keys.ToLower()
    if (-not $map.ContainsKey($k)) { "{`"ok`":false,`"error`":`"不支持的键: $Keys`"}"; exit 1 }
    [SigmaInput]::keybd_event([byte]$map[$k], 0, $si::KEYUP, [IntPtr]::Zero)
    "{`"ok`":true,`"released`":`"$k`"}"
  }

  'foreground' {
    $h = [SigmaInput]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][SigmaInput]::GetWindowTextW($h, $sb, 512)
    $pid_ = 0
    [void][SigmaInput]::GetWindowThreadProcessId($h, [ref]$pid_)
    $pname = ''
    try { $pname = (Get-Process -Id $pid_ -ErrorAction SilentlyContinue).ProcessName } catch { }
    "{`"ok`":true,`"hwnd`":`"$h`",`"title`":`"$($sb.ToString())`",`"process`":`"$pname`",`"pid`":$pid_}"
  }

  'focus' {
    # 按标题（模糊）或进程名激活窗口。找不到就报错，不瞎点。
    if (-not $Text) { "{`"ok`":false,`"error`":`"需要 -Text 指定标题或进程名`"}"; exit 1 }
    $target = Get-Process | Where-Object {
      $_.MainWindowTitle -and ($_.MainWindowTitle -like "*$Text*" -or $_.ProcessName -like "*$Text*")
    } | Select-Object -First 1
    if (-not $target) { "{`"ok`":false,`"error`":`"找不到窗口: $Text`"}"; exit 1 }
    # 用 WScript.Shell 的 AppActivate 最省事，按 PID 激活
    try {
      $ws = New-Object -ComObject WScript.Shell
      [void]$ws.AppActivate($target.Id)
      Start-Sleep -Milliseconds 200
      "{`"ok`":true,`"hwnd`":`"$($target.MainWindowHandle)`",`"title`":`"$($target.MainWindowTitle)`"}"
    } catch {
      "{`"ok`":false,`"error`":`"激活失败: $($_.Exception.Message)`"}"
    }
  }

  'release_all' {
    # 紧急释放：把所有可能卡住的修饰键和鼠标键全部抬起。
    # 用户觉得「键盘坏了」时，跑这一条就能恢复。
    foreach ($vk in 0x10,0x11,0x12,0x5B,0x5C) {
      [SigmaInput]::keybd_event([byte]$vk, 0, $si::KEYUP, [IntPtr]::Zero)
    }
    foreach ($f in $si::LEFTUP, $si::RIGHTUP, $si::MIDDLEUP) {
      [SigmaInput]::mouse_event($f, 0, 0, 0, [IntPtr]::Zero)
    }
    "{`"ok`":true,`"released`":`"all`"}"
  }

  default {
    "{`"ok`":false,`"error`":`"未知动作: $Action`"}"
    exit 1
  }
}
