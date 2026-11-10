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
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800, HWHEEL = 0x1000;
  public const uint KEYUP = 0x0002;
}
'@
}

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

  default {
    "{`"ok`":false,`"error`":`"未知动作: $Action`"}"
    exit 1
  }
}
