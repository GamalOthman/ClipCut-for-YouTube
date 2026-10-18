# ClipCut for YouTube - setup / update / uninstall
# Started by Setup.bat or Uninstall.bat. Works for the current Windows user, no admin rights.
# Tools already on the PC (Python, yt-dlp, ffmpeg, Deno) are used when they are good enough;
# only missing or too-old tools are downloaded, into %LOCALAPPDATA%\ClipCut.
# Safe to run again: it updates. Keep this file plain ASCII (PowerShell 5.1 reads it in the local code page).

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root     = Join-Path $env:LOCALAPPDATA 'ClipCut'
$OldRoot  = Join-Path $env:LOCALAPPDATA 'YTClip'           # folder used by earlier test versions
$Bin      = Join-Path $Root 'bin'
$PyDir    = Join-Path $Root 'python'
$Tmp      = Join-Path $Root 'download'
$ExtDir   = Join-Path $Root 'extension'
$HelpDir  = Join-Path $Root 'helper'
$HostName = 'com.ytclip.helper'
$ExtId    = 'dabeipjbcabghpeneiepbikhbdnolcnc'   # fixed by the "key" in the extension's manifest.json
$PyVer    = '3.12.10'
$MinYtdlp = '2025.11.12'                          # first yt-dlp that solves YouTube's puzzle with Deno

$Urls = @{
  python = "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip"
  ytdlp  = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  ffmpeg = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  deno   = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
}
$RegKeys = @(
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
)

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

function Stop-Helper {
  # stop the helper and any download it started, so files can be replaced or removed
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  } | ForEach-Object { try { $_.Kill() } catch {} }
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*ytclip_host.py*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  Start-Sleep -Milliseconds 500
}

function Fetch($url, $out) {
  Say "   downloading $url"
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -L --fail --retry 3 --ssl-revoke-best-effort -# -o $out $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path $out)) { return }
    Say "   curl failed (code $LASTEXITCODE). Trying another way..." 'Yellow'
  }
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  if (-not (Test-Path $out)) { throw "Download failed: $url" }
}

function Write-Text($path, $text, $encoding) {
  [IO.File]::WriteAllText($path, $text, $encoding)
}
$Utf8NoBom = New-Object Text.UTF8Encoding $false

function Refresh-Path {
  # this window may have an old PATH; read the current one from the registry
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $extra = @((Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'), (Join-Path $env:USERPROFILE '.deno\bin'))
  $env:Path = (@($m, $u) + $extra | Where-Object { $_ }) -join ';'
}

function Find-OnPath($name) {
  # first real program with this name on PATH (skips Microsoft Store shortcuts and our own copies)
  foreach ($c in @(Get-Command $name -All -CommandType Application -ErrorAction SilentlyContinue)) {
    $p = $c.Source
    if ($p -and ($p -notlike '*\WindowsApps\*') -and -not $p.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { return $p }
  }
  return $null
}

function Run-Quiet($exe, [string[]]$arguments) {
  # run a program, return its output lines (an empty list if it printed nothing), or $null if it fails
  $ErrorActionPreference = 'Continue'   # messages on stderr must not count as a failure
  try {
    $out = & $exe @arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ,@($out)
  } catch { return $null }
}

function Test-Python($exe) {
  if (-not $exe -or -not (Test-Path $exe)) { return $null }
  $out = Run-Quiet $exe @('-c', 'import sys, json, subprocess, winreg, msvcrt; print(sys.executable); print(1 if sys.version_info >= (3, 8) else 0)')
  if (-not $out -or $out[-1].Trim() -ne '1') { return $null }
  $p = $out[0].Trim()
  if ($p -like '*pythonw.exe') { $p = $p -replace 'pythonw\.exe$', 'python.exe' }
  return $p
}

function Get-YtdlpVersion($exe) {
  $out = Run-Quiet $exe @('--version')
  if (-not $out) { return $null }
  return "$($out[-1])".Trim()
}

function Get-YtdlpUpdateCmd($exe) {
  # pip-installed yt-dlp lives in ...\PythonXX\Scripts\yt-dlp.exe: update it with that Python's pip
  $dir = Split-Path -Parent $exe
  $py = Join-Path (Split-Path -Parent $dir) 'python.exe'
  if ((Split-Path -Leaf $dir) -ieq 'Scripts' -and (Test-Path $py)) {
    return @($py, '-m', 'pip', 'install', '--upgrade', 'yt-dlp[default]')
  }
  return @($exe, '-U')
}

function Run-Update([string[]]$cmd) {
  $ErrorActionPreference = 'Continue'
  Say ('   updating: ' + ($cmd -join ' '))
  $exe = $cmd[0]
  $rest = @($cmd | Select-Object -Skip 1)
  & $exe @rest 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "   $_" }
}

function Remove-Private($paths, $what) {
  $removed = $false
  foreach ($p in $paths) { if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue; $removed = $true } }
  if ($removed) { Say "   removed the copy of $what that Setup downloaded earlier (yours is used instead)" }
}

# ------------------------------------------------------------------ uninstall
if ($Uninstall) {
  Step 'Removing ClipCut for YouTube'
  Stop-Helper
  foreach ($k in $RegKeys) { if (Test-Path $k) { Remove-Item $k -Force; Say "   removed $k" } }
  if (Test-Path $Root) {
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $Root) { Say '   Some files are in use. Close Edge/Chrome and run Uninstall.bat again.' 'Yellow' }
    else { Say "   removed $Root (everything Setup downloaded, plus settings and log)" }
  } else { Say '   nothing was installed in your user folder' }
  if (Test-Path $OldRoot) { Remove-Item $OldRoot -Recurse -Force -ErrorAction SilentlyContinue }
  Say '   Python, yt-dlp, ffmpeg or Deno that you installed yourself were not touched.'
  Write-Host ''
  Say 'Done. Last step: open edge://extensions and click Remove on "ClipCut for YouTube".' 'Green'
  exit 0
}

# ------------------------------------------------------------------ install / update
try {
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'This setup needs 64-bit Windows.' }
  $ExtSrc = @('extension', 'Browser Extension') | Where-Object { Test-Path (Join-Path $Here $_) } | Select-Object -First 1
  if (-not $ExtSrc) { throw "The 'extension' folder is missing next to Setup.bat. Extract the whole zip first." }
  if (-not (Test-Path (Join-Path $Here 'helper'))) { throw "The 'helper' folder is missing next to Setup.bat. Extract the whole zip first." }

  Step '1/6  Preparing'
  New-Item -ItemType Directory -Force -Path $Root, $Bin, $Tmp | Out-Null
  Stop-Helper
  Refresh-Path
  Say "   install folder: $Root"
  if (Test-Path $OldRoot) {
    foreach ($f in @('settings.json', 'state.json')) {
      $src = Join-Path $OldRoot $f
      if ((Test-Path $src) -and -not (Test-Path (Join-Path $Root $f))) { Copy-Item $src $Root }
    }
    Remove-Item $OldRoot -Recurse -Force -ErrorAction SilentlyContinue
    $script:Moved = $true
    Say '   moved your settings from the old YTClip folder and removed it' 'Yellow'
  }
  $tools = [ordered]@{}

  # ---------------------------------------------------------------- Python
  Step '2/6  Python'
  $pyExe = $null
  $candidates = @()
  foreach ($n in @('python', 'python3')) { $p = Find-OnPath $n; if ($p) { $candidates += $p } }
  $py = Find-OnPath 'py'
  if ($py) { $o = Run-Quiet $py @('-3', '-c', 'import sys; print(sys.executable)'); if ($o) { $candidates += $o[-1].Trim() } }
  foreach ($c in $candidates) { $pyExe = Test-Python $c; if ($pyExe) { break } }
  if ($pyExe) {
    Say "   found on your PC: $pyExe" 'Green'
    Remove-Private @($PyDir) 'Python'
  } else {
    $pyExe = Join-Path $PyDir 'python.exe'
    if (-not (Test-Python $pyExe)) {
      Say '   not found on your PC; downloading a private copy (about 11 MB)'
      $z = Join-Path $Tmp 'python.zip'
      Fetch $Urls.python $z
      Expand-Archive -Path $z -DestinationPath $PyDir -Force
      Remove-Item $z -Force
    } else { Say '   using the private copy Setup downloaded earlier' }
    if (-not (Test-Python $pyExe)) { throw 'Python does not start.' }
  }
  $tools['python'] = $pyExe

  # ---------------------------------------------------------------- yt-dlp
  Step '3/6  yt-dlp (the downloader)'
  $privYt = Join-Path $Bin 'yt-dlp.exe'
  $yt = Find-OnPath 'yt-dlp'
  if ($yt) {
    $ver = Get-YtdlpVersion $yt
    $upd = Get-YtdlpUpdateCmd $yt
    Say "   found on your PC: $yt (version $ver)" 'Green'
    if ($upd[1] -eq '-m') {   # pip install: make sure the puzzle solver package is there too
      $hasEjs = Run-Quiet $upd[0] @('-c', 'import yt_dlp_ejs')
      if ($null -eq $hasEjs) { Say '   the puzzle solver (yt-dlp-ejs) is missing'; Run-Update $upd }
    }
    if (-not $ver -or $ver -lt $MinYtdlp) { Say '   too old; updating it'; Run-Update $upd; $ver = Get-YtdlpVersion $yt }
    if ($ver -and $ver -ge $MinYtdlp) {
      $tools['yt-dlp'] = $yt
      $tools['ytdlp_update'] = $upd
      Remove-Private @($privYt) 'yt-dlp'
    } else {
      Say '   could not update it; Setup will use its own copy instead' 'Yellow'
      $yt = $null
    }
  }
  if (-not $yt) {
    if (-not (Test-Path $privYt)) { Say '   downloading (about 18 MB)'; Fetch $Urls.ytdlp $privYt }
    else { Say '   using the copy Setup downloaded earlier; checking for an update'; Run-Update @($privYt, '-U') }
    Say ('   version ' + (Get-YtdlpVersion $privYt))
    $tools['yt-dlp'] = $privYt
    $tools['ytdlp_update'] = @($privYt, '-U')
  }

  # ---------------------------------------------------------------- ffmpeg
  Step '4/6  ffmpeg (joins and cuts video)'
  $ff = Find-OnPath 'ffmpeg'
  $fp = Find-OnPath 'ffprobe'
  if ($ff -and $fp -and ($null -ne (Run-Quiet $ff @('-version')))) {
    Say "   found on your PC: $ff" 'Green'
    Remove-Private @((Join-Path $Bin 'ffmpeg.exe'), (Join-Path $Bin 'ffprobe.exe')) 'ffmpeg'
  } else {
    $ff = Join-Path $Bin 'ffmpeg.exe'
    $fp = Join-Path $Bin 'ffprobe.exe'
    if (-not ((Test-Path $ff) -and (Test-Path $fp))) {
      Say '   not found on your PC; downloading (about 200 MB, this takes a while)'
      $z = Join-Path $Tmp 'ffmpeg.zip'
      $x = Join-Path $Tmp 'ffmpeg'
      Fetch $Urls.ffmpeg $z
      Say '   unpacking...'
      Expand-Archive -Path $z -DestinationPath $x -Force
      Get-ChildItem -Path $x -Recurse -Include 'ffmpeg.exe', 'ffprobe.exe' | Copy-Item -Destination $Bin -Force
      Remove-Item $x -Recurse -Force
      Remove-Item $z -Force
    } else { Say '   using the copy Setup downloaded earlier' }
    if (-not (Test-Path $ff)) { throw 'ffmpeg.exe was not found in the download.' }
  }
  $tools['ffmpeg'] = $ff
  $tools['ffprobe'] = $fp

  # ---------------------------------------------------------------- Deno
  Step '5/6  Deno (solves YouTube''s puzzle)'
  $dn = Find-OnPath 'deno'
  $dv = if ($dn) { Run-Quiet $dn @('--version') } else { $null }
  if ($dv -and ($dv[0] -match 'deno (\d+)\.') -and [int]$Matches[1] -ge 2) {
    Say "   found on your PC: $dn ($($dv[0]))" 'Green'
    Remove-Private @((Join-Path $Bin 'deno.exe')) 'Deno'
  } else {
    if ($dn) { Say "   the Deno on your PC is too old ($($dv | Select-Object -First 1)); using a private copy" 'Yellow' }
    $dn = Join-Path $Bin 'deno.exe'
    if (-not (Test-Path $dn)) {
      Say '   downloading (about 40 MB)'
      $z = Join-Path $Tmp 'deno.zip'
      Fetch $Urls.deno $z
      Expand-Archive -Path $z -DestinationPath $Bin -Force
      Remove-Item $z -Force
    } else { Say '   using the copy Setup downloaded earlier' }
  }
  $tools['deno'] = $dn

  # ---------------------------------------------------------------- extension and helper
  Step '6/6  Extension and helper'
  foreach ($pair in @(@($ExtSrc, $ExtDir), @('helper', $HelpDir))) {
    $src = Join-Path $Here $pair[0]
    robocopy $src $pair[1] /MIR /NJH /NJS /NFL /NDL /NP /XD __pycache__ | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying $($pair[0]) failed (robocopy code $LASTEXITCODE)." }
  }
  $global:LASTEXITCODE = 0

  # the helper reads tools.json to know which programs to use
  Write-Text (Join-Path $Root 'tools.json') (ConvertTo-Json -InputObject $tools) $Utf8NoBom

  # launcher Edge/Chrome start; written in the console code page so non-English folder names work
  $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  $bat = "@echo off`r`n`"$pyExe`" `"%~dp0ytclip_host.py`" %*`r`n"
  Write-Text (Join-Path $HelpDir 'run_helper.bat') $bat $oem

  $check = Run-Quiet $pyExe @('-c', "import sys; sys.path.insert(0, r'$HelpDir'); import ytclip_engine; print('ok')")
  if ($null -eq $check) { throw 'The helper does not load with this Python.' }
  Say '   helper ok'

  $manifestPath = Join-Path $HelpDir "$HostName.json"
  $manifest = [ordered]@{
    name            = $HostName
    description     = 'ClipCut for YouTube helper'
    path            = (Join-Path $HelpDir 'run_helper.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
  }
  Write-Text $manifestPath (ConvertTo-Json -InputObject $manifest) $Utf8NoBom
  foreach ($k in $RegKeys) {
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name '(default)' -Value $manifestPath
  }
  Say '   helper registered for Edge and Chrome'
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  if ((Test-Path $Bin) -and -not (Get-ChildItem $Bin -ErrorAction SilentlyContinue)) { Remove-Item $Bin -Force }

  # ---------------------------------------------------------------- summary and last step
  Write-Host ''
  Say 'Programs the extension will use:' 'White'
  foreach ($n in @('python', 'yt-dlp', 'ffmpeg', 'deno')) {
    $p = $tools[$n]
    $where = if ($p.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { 'downloaded by Setup' } else { 'already on your PC' }
    Say ('   {0,-7} {1}  ({2})' -f $n, $p, $where)
  }
  try { Set-Clipboard -Value $ExtDir } catch {}
  Write-Host ''
  Say 'Setup finished.' 'Green'
  Write-Host ''
  Say 'FIRST TIME ONLY - load the extension in Edge:' 'White'
  Say '  1. Edge opens the Extensions page (or type  edge://extensions  in the address bar).'
  Say '  2. Turn on "Developer mode" (left side, or bottom-left).'
  Say '  3. Click "Load unpacked", paste this folder path (already copied) and click "Select Folder":'
  Say "       $ExtDir" 'Yellow'
  Say '  4. Open any YouTube video. A scissors icon appears in the player bar, next to the settings gear.'
  Write-Host ''
  if ($script:Moved) {
    Say 'IMPORTANT: the install folder was renamed. On edge://extensions click Remove on the old extension,' 'Yellow'
    Say '           then do step 3 above with the new path.' 'Yellow'
    Write-Host ''
  }
  Say 'UPDATING: if the extension is already loaded, click its reload button on edge://extensions,' 'White'
  Say '          then reload your YouTube tabs.'
  Say 'If you later uninstall Python, yt-dlp, ffmpeg or Deno from your PC, run Setup.bat again.'
  try { Start-Process 'msedge.exe' -ArgumentList 'edge://extensions' } catch {}
  exit 0
}
catch {
  Write-Host ''
  Say ('Setup failed: ' + $_.Exception.Message) 'Red'
  Say 'If you are on an office network, it may block these downloads. Try another network (for example a phone hotspot) and run Setup.bat again.' 'Yellow'
  exit 1
}
