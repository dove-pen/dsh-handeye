# winui.ps1 - foreground / hit-test / atomic click / region crop for dsh-handeye.
#
# Modes: focus | click | hit | list | crop
#
# Why this exists (learned the hard way in a real task):
#   hand_focus and hand_click are two separate processes. Between them the
#   harness window (or anything else) can grab the foreground, so the click
#   lands on the wrong window and the tool still reports success.
#   Here focus + hit-test + click happen in ONE process, and the click is only
#   delivered when WindowFromPoint() at the target pixel belongs to the window
#   we were told to click. Otherwise we fail loudly instead of clicking blind.
#
# Design notes:
#   - Pure ASCII: Windows PowerShell 5.1 reads a BOM-less script as ANSI, so
#     non-ASCII comments or literals would be mangled. Chinese window titles
#     still work because they arrive as command-line arguments, not literals.
#   - No single-letter parameters: PowerShell keeps the declared type of a
#     script variable, so "param([int]$W)" makes any later "$w = <object>"
#     throw "cannot convert to System.Int32". Long names cost nothing here.
#   - DPI aware, otherwise window rects and click points drift on scaled displays.
#   - Writes JSON to -Out (UTF-8, no BOM) and never prints to stdout.

param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Hwnd = '',
  [string]$Title = '',
  [int]$PosX = 0,
  [int]$PosY = 0,
  [int]$SizeW = 0,
  [int]$SizeH = 0,
  [string]$Button = 'left',
  [switch]$Double,
  [int]$FocusTimeoutMs = 1200,
  [int]$Attempts = 5,
  [string]$Source = '',
  [string]$Image = '',
  [int]$Scale = 3,
  [switch]$DryRun,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Fail($code, $message, $extra) {
  $o = @{ ok = $false; code = $code; error = $message }
  if ($null -ne $extra) { $o.extra = $extra }
  Write-Result $o
  exit 1
}

$nativeSource = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinUi {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

  public const uint GA_ROOT = 2;
  public const uint GW_OWNER = 4;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;

  public static string TextOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(1024);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static string ClassOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(512);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static IntPtr RootAt(int px, int py) {
    POINT p = new POINT();
    p.X = px; p.Y = py;
    IntPtr child = WindowFromPoint(p);
    if (child == IntPtr.Zero) return IntPtr.Zero;
    return GetAncestor(child, GA_ROOT);
  }
}
'@

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null
} catch {
  # Another run in the same PowerShell session may have compiled it already.
}

try { [WinUi]::SetProcessDPIAware() | Out-Null } catch { }

function Get-WindowInfo($handle) {
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $rect = New-Object WinUi+RECT
  $null = [WinUi]::GetWindowRect($handle, [ref]$rect)
  return [pscustomobject]@{
    hwnd       = [int64]$handle
    title      = [WinUi]::TextOf($handle)
    className  = [WinUi]::ClassOf($handle)
    x          = [int]$rect.Left
    y          = [int]$rect.Top
    w          = [int]($rect.Right - $rect.Left)
    h          = [int]($rect.Bottom - $rect.Top)
    minimized  = [WinUi]::IsIconic($handle)
    foreground = ([WinUi]::GetForegroundWindow() -eq $handle)
  }
}

# Top-level windows in Z order (first = frontmost). Owned popups are skipped so
# tooltips and IME candidate lists do not shadow the real window.
function Get-AllWindows {
  $found = New-Object System.Collections.ArrayList
  $callback = [WinUi+EnumProc]{
    param($handle, $state)
    if ([WinUi]::IsWindowVisible($handle)) {
      $owner = [WinUi]::GetWindow($handle, [WinUi]::GW_OWNER)
      if ($owner -eq [IntPtr]::Zero) {
        $name = [WinUi]::TextOf($handle)
        if (-not [string]::IsNullOrWhiteSpace($name)) {
          [void]$found.Add([pscustomobject]@{ hwnd = [int64]$handle; title = $name; className = [WinUi]::ClassOf($handle) })
        }
      }
    }
    return $true
  }
  $null = [WinUi]::EnumWindows($callback, [IntPtr]::Zero)
  return $found
}

# Exact title beats prefix beats substring; restored beats minimized; foreground
# is the tie-breaker. This is what hand_focus never did.
function Find-Window($needle) {
  if ([string]::IsNullOrWhiteSpace($needle)) { return $null }
  $probe = $needle.Trim().ToLowerInvariant()
  $all = @(Get-AllWindows)
  $scored = @()
  $order = 0
  foreach ($win in $all) {
    $lower = $win.title.ToLowerInvariant()
    $score = -1
    if ($lower -eq $probe) { $score = 300 }
    elseif ($lower.StartsWith($probe)) { $score = 200 }
    elseif ($lower.Contains($probe)) { $score = 100 }
    if ($score -ge 0) {
      $handle = [IntPtr]$win.hwnd
      if (-not [WinUi]::IsIconic($handle)) { $score += 20 }
      if ([WinUi]::GetForegroundWindow() -eq $handle) { $score += 10 }
      $scored += [pscustomobject]@{ hwnd = [IntPtr]$handle; title = $win.title; score = $score; order = $order }
    }
    $order++
  }
  if ($scored.Count -eq 0) { return $null }
  return ($scored | Sort-Object -Property @{ Expression = 'score'; Descending = $true }, @{ Expression = 'order'; Descending = $false } | Select-Object -First 1)
}

function Set-WindowForeground($handle) {
  if ([WinUi]::IsIconic($handle)) { $null = [WinUi]::ShowWindow($handle, 9) }
  $null = [WinUi]::BringWindowToTop($handle)
  $null = [WinUi]::SetForegroundWindow($handle)
  if ([WinUi]::GetForegroundWindow() -eq $handle) { return $true }

  # Windows refuses SetForegroundWindow from a background process. Borrowing the
  # current foreground thread's input queue is the standard workaround.
  $foreground = [WinUi]::GetForegroundWindow()
  $ownerPid = 0
  $foregroundThread = [WinUi]::GetWindowThreadProcessId($foreground, [ref]$ownerPid)
  $myThread = [WinUi]::GetCurrentThreadId()
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $myThread) {
    try {
      $null = [WinUi]::AttachThreadInput($myThread, $foregroundThread, $true)
      $null = [WinUi]::BringWindowToTop($handle)
      $null = [WinUi]::SetForegroundWindow($handle)
    } finally {
      $null = [WinUi]::AttachThreadInput($myThread, $foregroundThread, $false)
    }
  }
  return ([WinUi]::GetForegroundWindow() -eq $handle)
}

function Confirm-Foreground($handle, $timeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ([WinUi]::GetForegroundWindow() -eq $handle) { return $true }
    Start-Sleep -Milliseconds 40
  }
  return ([WinUi]::GetForegroundWindow() -eq $handle)
}

function Resolve-Target {
  if (-not [string]::IsNullOrWhiteSpace($Hwnd)) {
    $handle = [IntPtr]([int64]$Hwnd)
    if (-not [WinUi]::IsWindow($handle)) { Fail 'window-not-found' ('hwnd ' + $Hwnd + ' is not a window') $null }
    return Get-WindowInfo $handle
  }
  if (-not [string]::IsNullOrWhiteSpace($Title)) {
    $hit = Find-Window $Title
    if ($null -eq $hit) { Fail 'window-not-found' ("no visible window matches '" + $Title + "'") $null }
    return Get-WindowInfo $hit.hwnd
  }
  return $null
}

try {
  switch ($Mode.ToLowerInvariant()) {

    'list' {
      $rows = @()
      foreach ($win in @(Get-AllWindows)) {
        $info = Get-WindowInfo ([IntPtr]$win.hwnd)
        if ($null -ne $info) { $rows += $info }
      }
      Write-Result @{ ok = $true; mode = 'list'; count = $rows.Count; windows = $rows }
      exit 0
    }

    'hit' {
      $root = [WinUi]::RootAt($PosX, $PosY)
      if ($root -eq [IntPtr]::Zero) {
        Write-Result @{ ok = $true; mode = 'hit'; x = $PosX; y = $PosY; window = $null }
        exit 0
      }
      Write-Result @{
        ok     = $true
        mode   = 'hit'
        x      = $PosX
        y      = $PosY
        window = [pscustomobject]@{ hwnd = [int64]$root; title = [WinUi]::TextOf($root); className = [WinUi]::ClassOf($root) }
      }
      exit 0
    }

    'focus' {
      $target = Resolve-Target
      if ($null -eq $target) { Fail 'bad-args' 'focus needs -Hwnd or -Title' $null }
      $handle = [IntPtr]$target.hwnd
      $null = Set-WindowForeground $handle
      $ok = Confirm-Foreground $handle $FocusTimeoutMs
      $after = Get-WindowInfo ([WinUi]::GetForegroundWindow())
      if (-not $ok) {
        Fail 'focus-failed' ('could not bring "' + $target.title + '" to the foreground') ([pscustomobject]@{ wanted = $target; actual = $after })
      }
      Write-Result @{ ok = $true; mode = 'focus'; window = $target; foreground = $after }
      exit 0
    }

    'click' {
      $target = Resolve-Target
      $used = 0
      $root = [IntPtr]::Zero
      $limit = [Math]::Max(1, $Attempts)
      for ($attempt = 0; $attempt -lt $limit; $attempt++) {
        $used = $attempt + 1
        if ($null -ne $target) {
          $null = Set-WindowForeground ([IntPtr]$target.hwnd)
          $null = Confirm-Foreground ([IntPtr]$target.hwnd) 300
        }
        Start-Sleep -Milliseconds 50
        $root = [WinUi]::RootAt($PosX, $PosY)
        if ($null -eq $target) { break }
        if ($root -eq [IntPtr]$target.hwnd) { break }
        # The harness window, a popup or a modal got in front: retry the focus.
        Start-Sleep -Milliseconds 120
      }

      $actual = Get-WindowInfo $root
      $actualTitle = ''
      if ($null -ne $actual) { $actualTitle = $actual.title }
      if ($null -ne $target -and $root -ne [IntPtr]$target.hwnd) {
        Fail 'wrong-window' ("pixel (" + $PosX + "," + $PosY + ") belongs to '" + $actualTitle + "', not to the requested '" + $target.title + "'; nothing was clicked") ([pscustomobject]@{ wanted = $target; actual = $actual; attempts = $used })
      }

      $null = [WinUi]::SetCursorPos($PosX, $PosY)
      Start-Sleep -Milliseconds 80
      if ($DryRun) {
        Write-Result @{
          ok         = $true
          mode       = 'click'
          dryRun     = $true
          x          = $PosX
          y          = $PosY
          hit        = $actual
          target     = $target
          attempts   = $used
          foreground = (Get-WindowInfo ([WinUi]::GetForegroundWindow()))
          double     = [bool]$Double
          button     = $Button
        }
        exit 0
      }
      $downFlag = [WinUi]::LEFTDOWN
      $upFlag = [WinUi]::LEFTUP
      if ($Button -eq 'right') { $downFlag = [WinUi]::RIGHTDOWN; $upFlag = [WinUi]::RIGHTUP }
      [WinUi]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      [WinUi]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
      if ($Double) {
        Start-Sleep -Milliseconds 60
        [WinUi]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [WinUi]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
      }
      Start-Sleep -Milliseconds 80

      Write-Result @{
        ok         = $true
        mode       = 'click'
        x          = $PosX
        y          = $PosY
        hit        = $actual
        target     = $target
        attempts   = $used
        foreground = (Get-WindowInfo ([WinUi]::GetForegroundWindow()))
        double     = [bool]$Double
        button     = $Button
      }
      exit 0
    }

    'grab' {
      # Capture straight from the screen with GDI++. Deliberately does NOT go
      # through handeye: capturing and cropping must not depend on the OCR
      # pipeline or on a separate process being able to write a temp file.
      if ([string]::IsNullOrWhiteSpace($Image)) { Fail 'bad-args' 'grab needs -Image' $null }

      Add-Type -AssemblyName System.Drawing

      $screenW = [WinUi]::GetSystemMetrics(0)
      $screenH = [WinUi]::GetSystemMetrics(1)
      if ($screenW -le 0 -or $screenH -le 0) { Fail 'no-screen' 'cannot read the screen size' $null }

      $cropX = [Math]::Max(0, [Math]::Min($PosX, $screenW - 1))
      $cropY = [Math]::Max(0, [Math]::Min($PosY, $screenH - 1))
      $cropW = [int]$SizeW
      $cropH = [int]$SizeH
      if ($cropW -le 0) { $cropW = $screenW - $cropX }
      if ($cropH -le 0) { $cropH = $screenH - $cropY }
      $cropW = [Math]::Min($cropW, $screenW - $cropX)
      $cropH = [Math]::Min($cropH, $screenH - $cropY)
      if ($cropW -le 0 -or $cropH -le 0) { Fail 'bad-region' 'region is outside the screen' $null }

      $factor = [Math]::Max(1, [Math]::Min(8, $Scale))
      $destW = [int]($cropW * $factor)
      $destH = [int]($cropH * $factor)

      $raw = New-Object System.Drawing.Bitmap($cropW, $cropH)
      try {
        $rawG = [System.Drawing.Graphics]::FromImage($raw)
        try {
          $size = New-Object System.Drawing.Size($cropW, $cropH)
          $rawG.CopyFromScreen($cropX, $cropY, 0, 0, $size)
        } finally { $rawG.Dispose() }

        $dest = New-Object System.Drawing.Bitmap($destW, $destH)
        try {
          $g = [System.Drawing.Graphics]::FromImage($dest)
          try {
            if ($factor -gt 1) {
              $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
              $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            }
            $g.DrawImage($raw, (New-Object System.Drawing.Rectangle(0, 0, $destW, $destH)))
          } finally { $g.Dispose() }

          $imageDir = [System.IO.Path]::GetDirectoryName($Image)
          if (-not [string]::IsNullOrWhiteSpace($imageDir) -and -not (Test-Path -LiteralPath $imageDir)) {
            $null = New-Item -ItemType Directory -Path $imageDir -Force
          }
          $dest.Save($Image, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $dest.Dispose() }
      } finally { $raw.Dispose() }

      Write-Result @{
        ok       = $true
        mode     = 'grab'
        image    = $Image
        screenW  = $screenW
        screenH  = $screenH
        region   = [pscustomobject]@{ x = $cropX; y = $cropY; w = $cropW; h = $cropH }
        scale    = $factor
        outW     = $destW
        outH     = $destH
        upscaled = ($factor -gt 1)
      }
      exit 0
    }

    'crop' {
      if ([string]::IsNullOrWhiteSpace($Source)) { Fail 'bad-args' 'crop needs -Source' $null }
      if ([string]::IsNullOrWhiteSpace($Image)) { Fail 'bad-args' 'crop needs -Image' $null }
      if (-not (Test-Path -LiteralPath $Source)) { Fail 'no-file' ('source not found: ' + $Source) $null }

      Add-Type -AssemblyName System.Drawing

      $bitmap = [System.Drawing.Image]::FromFile($Source)
      try {
        $sourceW = [int]$bitmap.Width
        $sourceH = [int]$bitmap.Height

        $cropX = [Math]::Max(0, [Math]::Min($PosX, $sourceW - 1))
        $cropY = [Math]::Max(0, [Math]::Min($PosY, $sourceH - 1))
        $cropW = [int]$SizeW
        $cropH = [int]$SizeH
        if ($cropW -le 0) { $cropW = $sourceW - $cropX }
        if ($cropH -le 0) { $cropH = $sourceH - $cropY }
        $cropW = [Math]::Min($cropW, $sourceW - $cropX)
        $cropH = [Math]::Min($cropH, $sourceH - $cropY)
        if ($cropW -le 0 -or $cropH -le 0) { Fail 'bad-region' 'region is outside the image' $null }

        $factor = [Math]::Max(1, [Math]::Min(8, $Scale))
        $destW = [int]($cropW * $factor)
        $destH = [int]($cropH * $factor)

        $dest = New-Object System.Drawing.Bitmap($destW, $destH)
        try {
          $graphics = [System.Drawing.Graphics]::FromImage($dest)
          try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $fromRect = New-Object System.Drawing.Rectangle($cropX, $cropY, $cropW, $cropH)
            $toRect = New-Object System.Drawing.Rectangle(0, 0, $destW, $destH)
            $graphics.DrawImage($bitmap, $toRect, $fromRect, [System.Drawing.GraphicsUnit]::Pixel)
          } finally { $graphics.Dispose() }

          $imageDir = [System.IO.Path]::GetDirectoryName($Image)
          if (-not [string]::IsNullOrWhiteSpace($imageDir) -and -not (Test-Path -LiteralPath $imageDir)) {
            $null = New-Item -ItemType Directory -Path $imageDir -Force
          }
          $dest.Save($Image, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $dest.Dispose() }

        Write-Result @{
          ok       = $true
          mode     = 'crop'
          image    = $Image
          sourceW  = $sourceW
          sourceH  = $sourceH
          region   = [pscustomobject]@{ x = $cropX; y = $cropY; w = $cropW; h = $cropH }
          scale    = $factor
          outW     = $destW
          outH     = $destH
          upscaled = ($factor -gt 1)
        }
        exit 0
      } finally { $bitmap.Dispose() }
    }

    default {
      Fail 'bad-mode' ('unknown mode: ' + $Mode) $null
    }
  }
} catch {
  $msg = $_.Exception.Message -replace '"', "'"
  $where = ''
  if ($_.InvocationInfo) {
    $where = ' @ line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + ($_.InvocationInfo.Line -replace '"', "'")
  }
  Fail 'exception' ($msg + $where) $null
}
