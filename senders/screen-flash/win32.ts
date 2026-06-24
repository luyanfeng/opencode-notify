/**
 * Windows 屏幕跑马灯
 *
 * 使用 PowerShell + .NET Windows Forms 创建屏幕四边彩色闪烁边框。
 * 将四边分成多个小段，逐帧偏移颜色，产生 LED 跑马灯流动效果。
 *
 * 所有数据通过 $form.Tag（Form 的真实属性）传递，避免事件回调作用域问题。
 */

import { spawn } from "node:child_process"
import type { ScreenFlashChannelConfig } from "../../config.js"

export async function flash(config: ScreenFlashChannelConfig): Promise<void> {
  try {
  const duration = config.duration ?? 3.0
  const speed = config.speed ?? 4.0
  const borderWidth = 8
  const totalMs = duration * 1000
  const intervalMs = Math.max(20, Math.min(150, Math.round(60 / speed)))
  const segSize = 10

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bc = @(
  [System.Drawing.Color]::Red,
  [System.Drawing.Color]::Orange,
  [System.Drawing.Color]::Yellow,
  [System.Drawing.Color]::LimeGreen,
  [System.Drawing.Color]::Blue,
  [System.Drawing.Color]::Purple
)
$g = New-Object System.Collections.ArrayList
for ($b = 0; $b -lt $bc.Length; $b++) {
  $n = ($b + 1) % $bc.Length
  for ($s = 0; $s -lt 8; $s++) {
    $r = [int]($bc[$b].R + ($bc[$n].R - $bc[$b].R) * $s / 8)
    $g_ = [int]($bc[$b].G + ($bc[$n].G - $bc[$b].G) * $s / 8)
    $b_ = [int]($bc[$b].B + ($bc[$n].B - $bc[$b].B) * $s / 8)
    [void]$g.Add([System.Drawing.Color]::FromArgb(255, [Math]::Min(255,$r), [Math]::Min(255,$g_), [Math]::Min(255,$b_)))
  }
}

$form = New-Object System.Windows.Forms.Form
$form.WindowState = 'Maximized'
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Fuchsia
$form.TransparencyKey = [System.Drawing.Color]::Fuchsia
# Tag 存哈希表: @{ offset=0; gradient=$g; segSize=${segSize}; bw=${borderWidth} }
$form.Tag = @{ offset = 0; gradient = $g; segSize = ${segSize}; bw = ${borderWidth} }

$form.Add_Paint({
  $d = $form.Tag
  $gfx = $args[1].Graphics
  $w = $form.ClientSize.Width
  $h = $form.ClientSize.Height
  $gr = $d.gradient
  $gl = $gr.Count
  $ss = $d.segSize
  $bw = $d.bw
  $off = $d.offset

  # 上边 (左→右)
  for ($x = 0; $x -lt $w; $x += $ss) {
    $gi = [int](($x / $ss) + $off) % $gl
    $sw = [Math]::Min($ss, $w - $x)
    $br = [System.Drawing.SolidBrush]::new($gr[$gi])
    $gfx.FillRectangle($br, $x, 0, $sw, $bw)
    $br.Dispose()
  }
  # 右边 (上→下)
  for ($y = 0; $y -lt $h; $y += $ss) {
    $gi = [int](($w / $ss) + ($y / $ss) + $off) % $gl
    $sh = [Math]::Min($ss, $h - $y)
    $br = [System.Drawing.SolidBrush]::new($gr[$gi])
    $gfx.FillRectangle($br, $w - $bw, $y, $bw, $sh)
    $br.Dispose()
  }
  # 下边 (右→左)
  for ($x = 0; $x -lt $w; $x += $ss) {
    $gi = [int](($w / $ss) + ($h / $ss) + ($x / $ss) + $off) % $gl
    $sw = [Math]::Min($ss, $w - $x)
    $br = [System.Drawing.SolidBrush]::new($gr[$gi])
    $gfx.FillRectangle($br, $w - $x - $sw, $h - $bw, $sw, $bw)
    $br.Dispose()
  }
  # 左边 (下→上)
  for ($y = 0; $y -lt $h; $y += $ss) {
    $gi = [int](($w / $ss) * 2 + ($h / $ss) + ($y / $ss) + $off) % $gl
    $sh = [Math]::Min($ss, $h - $y)
    $br = [System.Drawing.SolidBrush]::new($gr[$gi])
    $gfx.FillRectangle($br, 0, $h - $y - $sh, $bw, $sh)
    $br.Dispose()
  }
})

$form.Show()

# 点击穿透
$code = @'
[DllImport("user32.dll")]
public static extern int SetWindowLong(IntPtr h, int n, int v);
[DllImport("user32.dll")]
public static extern int GetWindowLong(IntPtr h, int n);
'@
$win32 = Add-Type -MemberDefinition $code -Name W -Namespace W -PassThru
$style = $win32::GetWindowLong($form.Handle, -20)
$win32::SetWindowLong($form.Handle, -20, $style -bor 0x20 -bor 0x80)

# 跑马灯循环
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.ElapsedMilliseconds -lt ${totalMs}) {
  $d = $form.Tag
  $d.offset = $d.offset + 1
  $form.Invalidate()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds ${intervalMs}
}
$sw.Stop()
$form.Close()
`.trim()

  spawn("powershell", [
    "-NoProfile",
    "-Command",
    psScript,
  ], {
    stdio: "ignore",
    detached: true,
    timeout: Math.max(5000, totalMs + 5000),
  }).unref()
  } catch {
    // Windows 跑马灯失败不影响主流程
  }
}
