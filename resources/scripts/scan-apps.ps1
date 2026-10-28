param(
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Expand-PathValue([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  $v = $value.Trim()
  if ($v.StartsWith('"')) {
    $end = $v.IndexOf('"', 1)
    if ($end -gt 1) { $v = $v.Substring(1, $end - 1) }
  }
  $v = $v.Trim('"')
  $v = [Environment]::ExpandEnvironmentVariables($v)
  return $v
}

function Get-IconFile([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $v = $raw.Trim()
  if ($v.StartsWith('"')) {
    $end = $v.IndexOf('"', 1)
    if ($end -gt 1) { $v = $v.Substring(1, $end - 1) }
  } else {
    $v = $v -replace ',\s*-?\d+\s*$', ''
  }
  $v = Expand-PathValue $v
  if ($v -and (Test-Path -LiteralPath $v -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $v).Path
  }
  return $null
}

function Get-ExecutableFromCommand([string]$command) {
  if ([string]::IsNullOrWhiteSpace($command)) { return $null }
  $c = $command.Trim()
  if ($c.StartsWith('"')) {
    $end = $c.IndexOf('"', 1)
    if ($end -gt 1) { $c = $c.Substring(1, $end - 1) }
  } else {
    $match = [regex]::Match($c, '^(.+?\.exe)(\s|$)', 'IgnoreCase')
    if ($match.Success) { $c = $match.Groups[1].Value } else { $c = ($c -split '\s+')[0] }
  }
  $c = Expand-PathValue $c
  if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path }
  return $null
}

function Get-FileSizeSafe([string]$file) {
  $item = Get-Item -LiteralPath $file
  if ($item) { return [int64]$item.Length }
  return [int64]0
}

function Get-NameScore([string]$name, [string]$candidate) {
  if ([string]::IsNullOrWhiteSpace($name)) { return 0 }
  $a = ($name.ToLowerInvariant() -replace '[^a-z0-9\u4e00-\u9fff]', '')
  $b = ([System.IO.Path]::GetFileNameWithoutExtension($candidate)).ToLowerInvariant() -replace '[^a-z0-9\u4e00-\u9fff]', ''
  if ([string]::IsNullOrWhiteSpace($a) -or [string]::IsNullOrWhiteSpace($b)) { return 0 }
  if ($a -eq $b) { return 100 }
  if ($a.Contains($b) -or $b.Contains($a)) { return 60 }
  return 0
}

$excludeExe = '(?i)(^|\\|/)(unins[0-9a-z]*|uninstall|uninstaller|setup|installer|update|updater|crash|crashpad|reporter|helper|elevate|notification|vc_redist|vcredist|dotnet|kgb|7z|winrar|dxsetup|directx)\.exe$'

$apps = New-Object System.Collections.ArrayList
$seenKeys = New-Object 'System.Collections.Generic.HashSet[string]'

$hives = @(
  @{ Hive = 'HKLM'; Reg = 'HKEY_LOCAL_MACHINE'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' },
  @{ Hive = 'HKLM'; Reg = 'HKEY_LOCAL_MACHINE'; Path = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' },
  @{ Hive = 'HKCU'; Reg = 'HKEY_CURRENT_USER'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' }
)

foreach ($hive in $hives) {
  $baseKey = "Registry::$($hive.Reg)\$($hive.Path)"
  if (-not (Test-Path -LiteralPath $baseKey)) { continue }
  $keys = Get-ChildItem -LiteralPath $baseKey
  foreach ($key in $keys) {
    $name = $key.GetValue('DisplayName')
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($key.GetValue('SystemComponent') -eq 1) { continue }
    if ($key.GetValue('ParentKeyName')) { continue }
    $releaseType = [string]$key.GetValue('ReleaseType')
    if ($releaseType -match '(?i)update|hotfix|service pack') { continue }
    if ($name -match '(?i)^(security update|update for|hotfix for|kb[0-9]+)') { continue }
    if ($name -match '(?i)windows driver package|windows 驱动程序包|microsoft visual c\+\+|microsoft \.net|windows software development kit|npcap') { continue }

    $regKeyPath = "$($hive.Reg)\$($hive.Path)\$($key.PSChildName)"
    if ($seenKeys.Contains($regKeyPath)) { continue }
    [void]$seenKeys.Add($regKeyPath)

    $displayIconRaw = [string]$key.GetValue('DisplayIcon')
    $displayIcon = Get-IconFile $displayIconRaw
    $uninstallString = [string]$key.GetValue('UninstallString')
    $modifyString = [string]$key.GetValue('ModifyPath')
    $installLocationRaw = [string]$key.GetValue('InstallLocation')
    $installLocation = Expand-PathValue $installLocationRaw
    if ($installLocation) {
      $installLocation = $installLocation.TrimEnd('\', '/')
    }
    if (-not $installLocation -or -not (Test-Path -LiteralPath $installLocation -PathType Container)) {
      $fromUninstall = Get-ExecutableFromCommand $uninstallString
      if ($fromUninstall) { $installLocation = Split-Path -Parent $fromUninstall }
    }
    if (-not $installLocation -and $displayIcon) {
      $installLocation = Split-Path -Parent $displayIcon
    }

    $candidates = New-Object System.Collections.ArrayList
    $candidateSeen = New-Object 'System.Collections.Generic.HashSet[string]'
    function Add-Candidate([string]$file, [string]$source, [int]$depth) {
      if ([string]::IsNullOrWhiteSpace($file)) { return }
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return }
      if ($file -notmatch '(?i)\.exe$') { return }
      $full = (Resolve-Path -LiteralPath $file).Path
      if ($candidateSeen.Contains($full.ToLowerInvariant())) { return }
      [void]$candidateSeen.Add($full.ToLowerInvariant())
      $score = 0
      if ($source -eq 'display-icon') { $score += 50 }
      $score += Get-NameScore $name $full
      if ($depth -eq 0) { $score += 15 }
      $score -= [Math]::Min($depth * 3, 15)
      if ($full -match $excludeExe) { $score -= 100 }
      [void]$candidates.Add([pscustomobject]@{
        path = $full
        source = $source
        depth = $depth
        score = $score
        size = Get-FileSizeSafe $full
      })
    }

    if ($displayIcon -and $displayIcon -match '(?i)\.exe$') {
      Add-Candidate $displayIcon 'display-icon' 0
    }
    if ($installLocation -and (Test-Path -LiteralPath $installLocation -PathType Container)) {
      $rootExes = Get-ChildItem -LiteralPath $installLocation -Filter '*.exe' -File -ErrorAction SilentlyContinue
      foreach ($exe in $rootExes) { Add-Candidate $exe.FullName 'install-root' 0 }
      if ($rootExes.Count -eq 0) {
        $nested = Get-ChildItem -LiteralPath $installLocation -Filter '*.exe' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue
        foreach ($exe in $nested) {
          $depth = (($exe.FullName.Substring($installLocation.Length).TrimStart('\') -split '\\').Count) - 1
          Add-Candidate $exe.FullName 'install-tree' $depth
        }
      }
    }
    $fromModify = Get-ExecutableFromCommand $modifyString
    if ($fromModify) { Add-Candidate $fromModify 'modify-command' 0 }

    $sorted = @($candidates | Sort-Object -Property score -Descending)
    $bestExe = $null
    if ($sorted.Count -gt 0) { $bestExe = $sorted[0].path }
    if (-not $installLocation -and $bestExe) { $installLocation = Split-Path -Parent $bestExe }

    $estimated = [int64]0
    $estimatedRaw = $key.GetValue('EstimatedSize')
    if ($estimatedRaw) { [int64]::TryParse([string]$estimatedRaw, [ref]$estimated) | Out-Null }

    [void]$apps.Add([pscustomobject]@{
      id = ("reg:" + $regKeyPath).ToLowerInvariant()
      name = [string]$name
      publisher = [string]$key.GetValue('Publisher')
      version = [string]$key.GetValue('DisplayVersion')
      installDate = [string]$key.GetValue('InstallDate')
      installLocation = $installLocation
      exe = $bestExe
      exeCandidates = @($sorted | Select-Object -First 12)
      displayIcon = $displayIcon
      displayIconRaw = $displayIconRaw
      uninstallString = $uninstallString
      estimatedSizeBytes = $estimated * 1024
      registryKey = ($regKeyPath -replace '^HKEY_LOCAL_MACHINE', 'HKLM' -replace '^HKEY_CURRENT_USER', 'HKCU')
      registryHive = $hive.Hive
      source = 'registry'
      url = [string]$key.GetValue('URLInfoAbout')
    })
  }
}

$shortcuts = New-Object System.Collections.ArrayList
$shortcutSeen = New-Object 'System.Collections.Generic.HashSet[string]'
$shortcutDirs = @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:AppData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:PUBLIC 'Desktop')
)
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $shortcutDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $links = Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
  foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link.FullName)
    $target = $shortcut.TargetPath
    if ([string]::IsNullOrWhiteSpace($target)) { continue }
    $target = [Environment]::ExpandEnvironmentVariables($target)
    if ($target -notmatch '(?i)\.exe$') { continue }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
    if ($shortcutSeen.Contains($link.FullName.ToLowerInvariant())) { continue }
    [void]$shortcutSeen.Add($link.FullName.ToLowerInvariant())
    [void]$shortcuts.Add([pscustomobject]@{
      name = [System.IO.Path]::GetFileNameWithoutExtension($link.Name)
      lnkPath = $link.FullName
      target = (Resolve-Path -LiteralPath $target).Path
      arguments = [string]$shortcut.Arguments
      workingDirectory = [string]$shortcut.WorkingDirectory
      iconLocation = [string]$shortcut.IconLocation
    })
  }
}

$services = New-Object System.Collections.ArrayList
$svcList = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue
foreach ($svc in $svcList) {
  [void]$services.Add([pscustomobject]@{
    name = [string]$svc.Name
    displayName = [string]$svc.DisplayName
    state = [string]$svc.State
    startMode = [string]$svc.StartMode
    pathName = [string]$svc.PathName
  })
}

$osCaption = ''
$osVersion = ''
$osBuild = ''
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
  $osCaption = [string]$os.Caption
  $osVersion = [string]$os.Version
  $osBuild = [string]$os.BuildNumber
}

$payload = [pscustomobject]@{
  ok = $true
  generatedAt = (Get-Date).ToString('o')
  computerName = [string]$env:COMPUTERNAME
  userName = [string]$env:USERNAME
  os = [pscustomobject]@{ caption = $osCaption; version = $osVersion; build = $osBuild }
  apps = @($apps)
  shortcuts = @($shortcuts)
  services = @($services)
}

try {
  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  $errorPayload = [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
  [System.IO.File]::WriteAllText($OutputPath, ($errorPayload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}
