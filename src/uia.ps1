# uia.ps1 - UI Automation backend for dsh-handeye.
#
# Modes: windows | tree | invoke | setvalue | focus | text | launch | batch
# Always writes a JSON result to -Out (UTF-8, no BOM) and never prints to stdout
# (stdout encoding is unreliable across code pages).
#
# Design notes:
#   - Pure ASCII on purpose: Windows PowerShell 5.1 reads a BOM-less script as
#     ANSI, so non-ASCII comments or literals would be mangled.
#   - DPI aware, otherwise BoundingRectangle comes back in logical pixels and
#     every coordinate is wrong on a scaled display.
#   - Reads the UI Automation tree only; it never moves the mouse or raises the
#     window, which is the whole point of doing this in the background.

param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Hwnd = '',
  [string]$Ref = '',
  [string]$Value = '',
  [string]$Target = '',
  [string]$TargetArgs = '',
  [int]$Depth = 3,
  [int]$Max = 400,
  [string]$ActionFile = '',
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
} catch {
  [System.IO.File]::WriteAllText($Out, '{"ok":false,"error":"cannot load UIAutomation assemblies: ' + ($_.Exception.Message -replace '"', "'") + '"}', (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}

try {
  Add-Type -Namespace DshHandeye -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' | Out-Null
  [DshHandeye.Dpi]::SetProcessDPIAware() | Out-Null
} catch { }

$script:AE = [System.Windows.Automation.AutomationElement]
$script:TS = [System.Windows.Automation.TreeScope]
$script:AnyCond = [System.Windows.Automation.Condition]::TrueCondition

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Patterns($el) {
  $list = @()
  $pairs = @(
    @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
    @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
    @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
    @('Select', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('Expand', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
    @('Scroll', [System.Windows.Automation.ScrollPattern]::Pattern),
    @('Text', [System.Windows.Automation.TextPattern]::Pattern)
  )
  foreach ($p in $pairs) {
    $obj = $null
    try {
      if ($el.TryGetCurrentPattern($p[1], [ref]$obj)) { $list += $p[0] }
    } catch { }
  }
  return $list
}

function ToInt($v) {
  # Some windows report NaN or +/-Infinity bounds (off-screen or minimized).
  # [int] on those throws and takes the whole call down, so clamp explicitly.
  try {
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 0 }
    if ($d -gt 2147483647) { return 2147483647 }
    if ($d -lt -2147483647) { return -2147483647 }
    return [int]$d
  } catch { return 0 }
}

function Get-Info($el, $ref) {
  $c = $null
  try { $c = $el.Current } catch { }
  if ($null -eq $c) {
    return [pscustomobject]@{ ref = $ref; name = ''; type = 'Unknown'; class = ''; autoId = ''; enabled = $false; offscreen = $true; x = 0; y = 0; w = 0; h = 0; patterns = @() }
  }
  $r = $c.BoundingRectangle
  return [pscustomobject]@{
    ref       = $ref
    name      = [string]$c.Name
    type      = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    class     = [string]$c.ClassName
    autoId    = [string]$c.AutomationId
    enabled   = [bool]$c.IsEnabled
    offscreen = [bool]$c.IsOffscreen
    x         = (ToInt $r.X)
    y         = (ToInt $r.Y)
    w         = (ToInt $r.Width)
    h         = (ToInt $r.Height)
    patterns  = (Get-Patterns $el)
  }
}

function Get-Root($hwnd) {
  if ([string]::IsNullOrWhiteSpace($hwnd)) { return $script:AE::RootElement }
  $h = [IntPtr]([int64]$hwnd)
  return $script:AE::FromHandle($h)
}

function Resolve-Ref($ref) {
  # ref = "<hwnd>:<child>.<child>..."
  $parts = $ref.Split(':')
  if ($parts.Length -lt 1) { throw "bad ref: $ref" }
  $el = Get-Root $parts[0]
  if ($parts.Length -lt 2 -or [string]::IsNullOrWhiteSpace($parts[1])) { return $el }
  foreach ($seg in $parts[1].Split('.')) {
    $idx = [int]$seg
    $kids = $el.FindAll($script:TS::Children, $script:AnyCond)
    if ($idx -lt 0 -or $idx -ge $kids.Count) { throw ("ref path out of range at segment " + $seg + " in " + $ref) }
    $el = $kids.Item($idx)
  }
  return $el
}

function Walk($el, $path, $depth, $max, $acc, $rootHwnd) {
  if ($depth -lt 0 -or $acc.Count -ge $max) { return }
  $kids = $null
  try { $kids = $el.FindAll($script:TS::Children, $script:AnyCond) } catch { return }
  $i = 0
  foreach ($k in $kids) {
    if ($acc.Count -ge $max) { return }
    $childPath = if ([string]::IsNullOrEmpty($path)) { [string]$i } else { "$path.$i" }
    $ref = "$rootHwnd" + ':' + $childPath
    $null = $acc.Add((Get-Info $k $ref))
    Walk $k $childPath ($depth - 1) $max $acc $rootHwnd
    $i = $i + 1
  }
}

function Do-Invoke($ref) {
  $el = Resolve-Ref $ref
  $obj = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) {
    $obj.Invoke(); return @{ ok = $true; via = 'Invoke' }
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$obj)) {
    $obj.Toggle(); return @{ ok = $true; via = 'Toggle' }
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$obj)) {
    $obj.Select(); return @{ ok = $true; via = 'Select' }
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$obj)) {
    $obj.Expand(); return @{ ok = $true; via = 'Expand' }
  }
  throw "this control supports no invoke/toggle/select/expand pattern (ref=$ref)"
}

function Do-SetValue($ref, $text) {
  $el = Resolve-Ref $ref
  $obj = $null
  if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) {
    throw "this control has no ValuePattern (ref=$ref); use hand_type instead"
  }
  $obj.SetValue([string]$text)
  return @{ ok = $true; via = 'ValuePattern' }
}

$result = $null
try {
  switch ($Mode) {
    'windows' {
      $root = $script:AE::RootElement
      $kids = $root.FindAll($script:TS::Children, $script:AnyCond)
      $list = @()
      foreach ($k in $kids) {
        $info = Get-Info $k ''
        if ($info.type -eq 'Unknown') { continue }
        $list += [pscustomobject]@{
          hwnd    = [int64]$k.Current.NativeWindowHandle
          pid     = [int]$k.Current.ProcessId
          name    = $info.name
          class   = $info.class
          x = $info.x; y = $info.y; w = $info.w; h = $info.h
          offscreen = $info.offscreen
        }
      }
      $result = @{ ok = $true; count = $list.Count; windows = $list }
    }
    'tree' {
      if ([string]::IsNullOrWhiteSpace($Hwnd)) { throw 'tree needs -Hwnd' }
      $root = Get-Root $Hwnd
      $acc = New-Object System.Collections.ArrayList
      $head = Get-Info $root ("$Hwnd" + ':')
      $acc.Add($head) | Out-Null
      Walk $root '' $Depth $Max $acc $Hwnd
      $result = @{ ok = $true; hwnd = [int64]$Hwnd; count = $acc.Count; nodes = $acc }
    }
    'invoke' { $result = Do-Invoke $Ref }
    'setvalue' { $result = Do-SetValue $Ref $Value }
    'focus' {
      $el = Resolve-Ref $Ref
      $el.SetFocus()
      $result = @{ ok = $true; via = 'SetFocus' }
    }
    'text' {
      if ([string]::IsNullOrWhiteSpace($Hwnd)) { throw 'text needs -Hwnd' }
      $root = Get-Root $Hwnd
      $acc = New-Object System.Collections.ArrayList
      Walk $root '' $Depth $Max $acc $Hwnd
      $seen = New-Object System.Collections.Generic.HashSet[string]
      $lines = @()
      foreach ($n in $acc) {
        $t = [string]$n.name
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        if ($seen.Add($t)) { $lines += [pscustomobject]@{ text = $t; type = $n.type; x = $n.x; y = $n.y; ref = $n.ref } }
      }
      $result = @{ ok = $true; hwnd = [int64]$Hwnd; count = $lines.Count; lines = $lines }
    }
    'launch' {
      if ([string]::IsNullOrWhiteSpace($Target)) { throw 'launch needs -Target' }
      if ([string]::IsNullOrWhiteSpace($TargetArgs)) {
        $p = Start-Process -FilePath $Target -PassThru
      } else {
        $p = Start-Process -FilePath $Target -ArgumentList $TargetArgs -PassThru
      }
      $result = @{ ok = $true; pid = $p.Id; target = $Target }
    }
    'batch' {
      if ([string]::IsNullOrWhiteSpace($ActionFile)) { throw 'batch needs -ActionFile' }
      $raw = [System.IO.File]::ReadAllText($ActionFile, [System.Text.Encoding]::UTF8)
      $actions = $raw | ConvertFrom-Json
      $done = @()
      $failed = $null
      $i = 0
      foreach ($a in $actions) {
        $i = $i + 1
        try {
          $r = $null
          switch ([string]$a.op) {
            'invoke' { $r = Do-Invoke ([string]$a.ref) }
            'setvalue' { $r = Do-SetValue ([string]$a.ref) ([string]$a.value) }
            'focus' { (Resolve-Ref ([string]$a.ref)).SetFocus(); $r = @{ ok = $true; via = 'SetFocus' } }
            default { throw ("unknown op: " + [string]$a.op) }
          }
          $done += [pscustomobject]@{ step = $i; op = [string]$a.op; ok = $true; via = $r.via }
        } catch {
          $failed = [pscustomobject]@{ step = $i; op = [string]$a.op; error = $_.Exception.Message }
          break
        }
      }
      $result = @{ ok = ($null -eq $failed); steps = $done; failed = $failed }
    }
    default { throw "unknown mode: $Mode" }
  }
} catch {
  $msg = $_.Exception.Message -replace '"', "'" -replace "`r?`n", ' '
  Write-Result @{ ok = $false; error = $msg; mode = $Mode }
  exit 2
}

if ($null -eq $result) { $result = @{ ok = $false; error = 'no result' } }
Write-Result $result
