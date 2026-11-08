<#
.SYNOPSIS
  LLM Load Test — one-click installer untuk Windows 10/11.

.DESCRIPTION
  Memasang Node.js (bila belum ada), k6 (bila belum ada), menyalin aplikasi,
  membuat password Basic Auth, lalu menjalankan dashboard di http://localhost:8787.

.PARAMETER Port
  Port dashboard. Default 8787.

.PARAMETER InstallDir
  Folder instalasi. Default: %LOCALAPPDATA%\llm-loadtest

.PARAMETER NoAuth
  Nonaktifkan Basic Auth (tidak disarankan bila port terbuka).

.PARAMETER AutoStart
  Daftarkan dashboard agar otomatis jalan saat user login (Scheduled Task).

.PARAMETER AddFirewallRule
  Buka port di Windows Firewall (butuh PowerShell sebagai Administrator).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 9000 -AutoStart

.EXAMPLE
  irm https://raw.githubusercontent.com/keplia/llm-loadtest/main/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'llm-loadtest'),
  [string]$BindHost = '0.0.0.0',
  [switch]$NoAuth,
  [string]$AuthUser = 'admin',
  [string]$AuthPass = '',
  [switch]$AutoStart,
  [switch]$AddFirewallRule,
  [switch]$NoStart,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 5) {
  Write-Host '[x] Butuh PowerShell 5.1 atau lebih baru.' -ForegroundColor Red
  exit 1
}

$RepoSlug = 'keplia/llm-loadtest'
$Branch   = 'main'
$TaskName = 'LLM Load Test'

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ------------------------------------------------------------------ helpers --
function Write-Step($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-Arch {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
  return 'amd64'
}

# --------------------------------------------------------------- uninstall ---
if ($Uninstall) {
  Write-Step 'Menghentikan dashboard…'
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallDir*server.js*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
  try {
    Get-NetFirewallRule -DisplayName "LLM Load Test ($Port)" -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
  } catch { }
  Write-Ok 'Service/scheduled task dihapus.'
  if ($Purge) {
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Folder $InstallDir dihapus."
  } else {
    Write-Host "  Data & konfigurasi tetap di $InstallDir (pakai -Purge untuk menghapus)."
  }
  exit 0
}

if ($Port -lt 1 -or $Port -gt 65535) { Fail "Port tidak valid: $Port" }

# ---------------------------------------------------------------- node.js ----
function Test-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try {
    $major = [int](& node -p "process.versions.node.split('.')[0]" 2>$null)
    return ($major -ge 20)
  } catch { return $false }
}

function Install-Node {
  Write-Step 'Memasang Node.js 22 LTS…'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install --id OpenJS.NodeJS.LTS -e --silent `
        --accept-source-agreements --accept-package-agreements | Out-Host
      Refresh-Path
    } catch {
      Write-Warn2 "winget gagal: $($_.Exception.Message)"
    }
  }
  if (-not (Test-Node)) {
    Write-Step 'Mengunduh installer resmi Node.js…'
    $arch = if ((Get-Arch) -eq 'arm64') { 'arm64' } else { 'x64' }
    $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    if (-not $lts) { Fail 'Tidak bisa menentukan versi Node.js LTS.' }
    $ver = $lts.version
    $msi = Join-Path $env:TEMP "node-$ver-$arch.msi"
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/node-$ver-$arch.msi" -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    Refresh-Path
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Node)) { Fail 'Node.js belum terpasang dengan benar. Install manual dari https://nodejs.org lalu jalankan ulang.' }
}

# --------------------------------------------------------------------- k6 ----
function Test-K6 { return [bool](Get-Command k6 -ErrorAction SilentlyContinue) }

function Install-K6 {
  Write-Step 'Memasang k6…'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install --id k6.k6 -e --silent `
        --accept-source-agreements --accept-package-agreements | Out-Host
      Refresh-Path
    } catch {
      Write-Warn2 "winget gagal: $($_.Exception.Message)"
    }
  }
  if (-not (Test-K6)) {
    Write-Step 'Mengunduh k6 dari GitHub…'
    $release = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/grafana/k6/releases/latest'
    $tag = $release.tag_name
    if (-not $tag) { Fail 'Tidak bisa menentukan versi k6 terbaru.' }
    $arch = Get-Arch
    $zip = Join-Path $env:TEMP "k6-$tag.zip"
    Invoke-WebRequest -UseBasicParsing `
      "https://github.com/grafana/k6/releases/download/$tag/k6-$tag-windows-$arch.zip" -OutFile $zip
    $extract = Join-Path $env:TEMP "k6-$tag-extract"
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $binDir = Join-Path $InstallDir 'bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $exe = Get-ChildItem -Path $extract -Filter 'k6.exe' -Recurse | Select-Object -First 1
    if (-not $exe) { Fail 'k6.exe tidak ditemukan di dalam arsip.' }
    Copy-Item $exe.FullName (Join-Path $binDir 'k6.exe') -Force
    Remove-Item $zip, $extract -Recurse -Force -ErrorAction SilentlyContinue

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if ($userPath -notlike "*$binDir*") {
      $newPath = ($userPath.TrimEnd(';') + ';' + $binDir).TrimStart(';')
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    $env:Path = "$env:Path;$binDir"
  }
}

# ------------------------------------------------------------------ source ---
function Copy-App([string]$From, [string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $skip = @('runs', '.git', 'node_modules', '.auth.env', '.access.txt')
  Get-ChildItem -Force -Path $From | ForEach-Object {
    if ($skip -contains $_.Name) { return }
    Copy-Item $_.FullName -Destination $To -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $To 'runs') | Out-Null
}

# ------------------------------------------------------------------- main ----
Write-Host ''
Write-Host '  LLM Load Test installer' -ForegroundColor White
Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Node)) { Install-Node }
Write-Ok "Node.js $(& node -v)"

if (-not (Test-K6)) { Install-K6 }
if (-not (Test-K6)) { Fail 'k6 belum terpasang. Install manual dari https://k6.io/docs/get-started/installation/ lalu jalankan ulang.' }
Write-Ok "k6 $(& k6 version)"

Write-Step "Menyalin aplikasi ke $InstallDir…"
$localSource = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'server.js'))) {
  $localSource = $PSScriptRoot
}
if ($localSource) {
  Copy-App -From $localSource -To $InstallDir
} else {
  $zip = Join-Path $env:TEMP "llm-loadtest-$([guid]::NewGuid().ToString('N')).zip"
  $tmp = Join-Path $env:TEMP "llm-loadtest-src-$([guid]::NewGuid().ToString('N'))"
  Invoke-WebRequest -UseBasicParsing `
    "https://codeload.github.com/$RepoSlug/zip/refs/heads/$Branch" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  Copy-App -From $root.FullName -To $InstallDir
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path (Join-Path $InstallDir 'server.js'))) { Fail 'Source tidak lengkap: server.js tidak ditemukan.' }
Write-Ok 'Aplikasi tersalin.'

# ---------------------------------------------------------------- auth -------
$authEnabled = $true
$envFile = Join-Path $InstallDir '.auth.env'
if ($NoAuth) {
  Remove-Item $envFile -Force -ErrorAction SilentlyContinue
  $authEnabled = $false
  Write-Warn2 'Basic Auth NONAKTIF — siapa pun yang bisa menjangkau port ini dapat memakainya.'
} else {
  if (Test-Path $envFile) {
    $cfg = @{}
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^([^=]+)=(.*)$') { $cfg[$matches[1].Trim()] = $matches[2] }
    }
    if ($cfg['AUTH_USER']) { $AuthUser = $cfg['AUTH_USER'] }
    if ($cfg['AUTH_PASS']) { $AuthPass = $cfg['AUTH_PASS'] }
    Write-Ok "Basic Auth sudah ada (user: $AuthUser)."
  } else {
    if (-not $AuthPass) {
      $chars = (48..57) + (65..90) + (97..122)
      $AuthPass = -join ($chars | Get-Random -Count 14 | ForEach-Object { [char]$_ })
    }
    Set-Content -Path $envFile -Value "AUTH_USER=$AuthUser`nAUTH_PASS=$AuthPass" -Encoding ASCII
    Write-Ok "Basic Auth dibuat (user: $AuthUser)."
  }
}

# --------------------------------------------------------------- launcher ----
$startPs1 = @'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root ".auth.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") {
      [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], "Process")
    }
  }
}
if (-not $env:HOST) { $env:HOST = "__HOST__" }
if (-not $env:PORT) { $env:PORT = "__PORT__" }
Set-Location $root
Write-Host ""
Write-Host "  LLM Load Test -> http://localhost:$env:PORT" -ForegroundColor Cyan
Write-Host "  Tekan Ctrl+C untuk berhenti." -ForegroundColor DarkGray
Write-Host ""
node server.js
'@
$startPs1 = $startPs1.Replace('__HOST__', $BindHost).Replace('__PORT__', "$Port")
Set-Content -Path (Join-Path $InstallDir 'start.ps1') -Value $startPs1 -Encoding UTF8

$startCmd = @"
@echo off
title LLM Load Test
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
"@
Set-Content -Path (Join-Path $InstallDir 'start.cmd') -Value $startCmd -Encoding ASCII
Write-Ok 'Launcher dibuat (start.cmd / start.ps1).'

# -------------------------------------------------------------- shortcut -----
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $ws = New-Object -ComObject WScript.Shell
    $lnkPath = Join-Path $desktop 'LLM Load Test.lnk'
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = Join-Path $InstallDir 'start.cmd'
    $lnk.WorkingDirectory = $InstallDir
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
    $lnk.Description = 'LLM Load Test dashboard'
    $lnk.Save()
    Write-Ok 'Shortcut dibuat di Desktop.'
  }
} catch { Write-Warn2 "Tidak bisa membuat shortcut: $($_.Exception.Message)" }

# ------------------------------------------------------------- autostart -----
if ($AutoStart) {
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\start.ps1`"" `
      -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
      -Description 'LLM Load Test dashboard' -Force | Out-Null
    Write-Ok 'Auto-start saat login diaktifkan (Scheduled Task).'
  } catch {
    Write-Warn2 "Gagal membuat scheduled task: $($_.Exception.Message)"
  }
}

# -------------------------------------------------------------- firewall -----
if ($AddFirewallRule) {
  if (Test-IsAdmin) {
    try {
      New-NetFirewallRule -DisplayName "LLM Load Test ($Port)" -Direction Inbound `
        -Protocol TCP -LocalPort $Port -Action Allow -ErrorAction Stop | Out-Null
      Write-Ok "Windows Firewall: port $Port dibuka."
    } catch { Write-Warn2 "Gagal membuka firewall: $($_.Exception.Message)" }
  } else {
    Write-Warn2 'Membuka firewall butuh PowerShell sebagai Administrator. Jalankan ulang dengan -AddFirewallRule sebagai admin.'
  }
}

# ----------------------------------------------------------------- start -----
if (-not $NoStart) {
  Write-Step 'Menjalankan dashboard…'
  Start-Process -FilePath (Join-Path $InstallDir 'start.cmd') -WorkingDirectory $InstallDir
  Start-Sleep -Seconds 2
  try { Start-Process "http://localhost:$Port" } catch { }
}

# --------------------------------------------------------------- ringkasan ---
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
} catch { }

Write-Host ''
Write-Host '  =============================================' -ForegroundColor DarkGray
Write-Host '   LLM Load Test siap dipakai' -ForegroundColor Green
Write-Host '  =============================================' -ForegroundColor DarkGray
Write-Host "   Lokal    : http://localhost:$Port"
foreach ($ip in $ips) { Write-Host "   Jaringan : http://${ip}:$Port" }
if ($authEnabled) {
  Write-Host ''
  Write-Host "   Login    : $AuthUser / $AuthPass" -ForegroundColor Yellow
  Write-Host "   Simpan password ini. Ubah di $envFile"
} else {
  Write-Host ''
  Write-Host '   Login    : (tidak aktif)'
}
Write-Host ''
$shownScript = if ($PSCommandPath) { $PSCommandPath } else { 'install.ps1' }
Write-Host '   Mulai lagi : jalankan start.cmd (atau shortcut Desktop)'
Write-Host "   Uninstall  : powershell -ExecutionPolicy Bypass -File `"$shownScript`" -Uninstall"
Write-Host ''
Write-Host '   Catatan: bila PC berada di belakang NAT, akses dari internet'
Write-Host '   memerlukan tunnel (mis. Tailscale Funnel). Lihat README.'
Write-Host ''
