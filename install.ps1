param(
    # A faster-whisper model name (tiny, base, small, medium, large-v3, large-v3-turbo) or a local model folder.
    [string]$Model
)
$ErrorActionPreference = 'Stop'
$hostName = 'local.video_transcripts'

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3.11 or newer is required. Install it from https://www.python.org/downloads/ and run this script again.' }
& $python.Source -c 'import sys; sys.exit(sys.version_info < (3, 11))'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer is required.' }

$venv = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) { & $python.Source -m venv $venv }
& $venvPython -m pip install --disable-pip-version-check 'faster-whisper==1.2.1' 'sentencepiece==0.2.2'
if ($LASTEXITCODE -ne 0) { throw 'Installing the Python packages failed.' }
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    Write-Host 'NVIDIA GPU found. Installing the CUDA libraries Whisper needs (about 1 GB).'
    & $venvPython -m pip install --disable-pip-version-check 'nvidia-cublas-cu12==12.*' 'nvidia-cudnn-cu12==9.*'
    if ($LASTEXITCODE -ne 0) { throw 'Installing the CUDA libraries failed.' }
}

if (-not $Model) {
    Write-Host ''
    Write-Host 'Choose the Whisper model to download to this computer. Larger models are more accurate but slower.'
    Write-Host '  small           ~500 MB, fine on most CPUs'
    Write-Host '  medium          ~1.5 GB'
    Write-Host '  large-v3-turbo  ~1.6 GB, best with an NVIDIA GPU'
    Write-Host 'You can also enter the path of a faster-whisper (CTranslate2) model folder you already have.'
    $Model = Read-Host 'Model [large-v3-turbo]'
    if (-not $Model) { $Model = 'large-v3-turbo' }
}
& $venvPython (Join-Path $PSScriptRoot 'setup_models.py') $Model
if ($LASTEXITCODE -ne 0) { throw 'Model setup failed. The Chrome connection has not been registered.' }

# The extension ID is derived from the manifest key, so the host only accepts this extension.
$extensionManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension\manifest.json') -Raw | ConvertFrom-Json
$keyBytes = [Convert]::FromBase64String($extensionManifest.key)
$hasher = [System.Security.Cryptography.SHA256]::Create()
$keyHash = $hasher.ComputeHash($keyBytes)
$extensionId = -join ($keyHash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
$hasher.Dispose()

$hostLauncher = Join-Path $PSScriptRoot 'host.cmd'
$launcherText = "@echo off`r`n`"$venvPython`" -u `"%~dp0host.py`" %*`r`n"
[System.IO.File]::WriteAllText($hostLauncher, $launcherText, [System.Text.UTF8Encoding]::new($false))
$hostManifest = Join-Path $PSScriptRoot 'native-host.json'
$registration = @{
    name = $hostName
    description = 'Local Italian and English video transcription and translation'
    path = $hostLauncher
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($hostManifest, $registration, [System.Text.UTF8Encoding]::new($false))
$registryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryKey -Force | Out-Null
Set-Item -LiteralPath $registryKey -Value $hostManifest
Write-Host "Chrome connection installed for extension $extensionId"
Write-Host 'In chrome://extensions, turn on Developer mode, click Load unpacked, and select:'
Write-Host (Join-Path $PSScriptRoot 'extension')
Write-Host 'If the side panel was already open, click "Check again" in it.'
