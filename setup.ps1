# setup.ps1 - create the project-local VoxCPM2 environment and download its model.
[CmdletBinding()]
param(
    [string]$Python = "",
    [switch]$Cpu
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir = Join-Path $Root "venv-voxcpm"
$ModelDir = Join-Path $Root "models\VoxCPM2"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

Write-Host "SlapSlap setup"
Write-Host "Project root: $Root"

function Invoke-Native {
    param([string]$Exe, [string[]]$CmdArgs, [string]$What)
    & $Exe @CmdArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$What failed with exit code $LASTEXITCODE"
        exit 1
    }
}

function Get-PythonLauncher {
    param([string]$Explicit)
    if ($Explicit) { return ,@($Explicit) }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            $v = & py -3.11 --version 2>$null
            if ($LASTEXITCODE -eq 0 -and "$v" -match '3\.11') { return ,@('py', '-3.11') }
        } catch { }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try {
            $v = & python --version 2>$null
            if ($LASTEXITCODE -eq 0 -and "$v" -match '3\.11') { return ,@('python') }
        } catch { }
    }
    return $null
}

$launcher = Get-PythonLauncher -Explicit $Python
if (-not $launcher) {
    Write-Error "Python 3.11 not found. Install Python 3.11 or run: setup.ps1 -Python <path-to-python.exe>"
    exit 1
}
$launcherExe = $launcher[0]
$launcherArgs = @()
if ($launcher.Count -gt 1) { $launcherArgs = $launcher[1..($launcher.Count - 1)] }
Write-Host "Python launcher: $launcherExe $($launcherArgs -join ' ')"

if (-not (Test-Path -LiteralPath $VenvDir)) {
    Write-Host "Creating virtual environment: $VenvDir"
    Invoke-Native $launcherExe ($launcherArgs + @('-m', 'venv', $VenvDir)) "venv creation"
} else {
    Write-Host "Virtual environment already exists: $VenvDir"
}

if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Error "venv python not found: $VenvPython"
    exit 1
}

Write-Host "Upgrading pip..."
Invoke-Native $VenvPython @('-m', 'pip', 'install', '--upgrade', 'pip', 'wheel') "pip upgrade"

if ($Cpu) {
    Write-Host "Installing CPU torch..."
    Invoke-Native $VenvPython @('-m', 'pip', 'install', 'torch==2.11.0', 'torchaudio==2.11.0') "CPU torch install"
} else {
    Write-Host "Installing CUDA 12.8 torch..."
    Invoke-Native $VenvPython @('-m', 'pip', 'install', 'torch==2.11.0', 'torchaudio==2.11.0', '--index-url', 'https://download.pytorch.org/whl/cu128') "CUDA torch install"
}

Write-Host "Installing requirements..."
Invoke-Native $VenvPython @('-m', 'pip', 'install', '-r', (Join-Path $Root "requirements.txt")) "requirements install"

$configOk = Test-Path -LiteralPath (Join-Path $ModelDir "config.json")
$weightsOk = Test-Path -LiteralPath (Join-Path $ModelDir "model.safetensors")
if ($configOk -and $weightsOk) {
    Write-Host "VoxCPM2 model already present: $ModelDir"
} else {
    Write-Host "Downloading openbmb/VoxCPM2 to $ModelDir (this can take a while)..."
    $env:VOXCPM_LOCAL_DIR = $ModelDir
    Invoke-Native $VenvPython @('-c', "import os; from huggingface_hub import snapshot_download; snapshot_download('openbmb/VoxCPM2', local_dir=os.environ['VOXCPM_LOCAL_DIR'])") "model download"
}

Write-Host "Verifying installation..."
Invoke-Native $VenvPython @('-c', "import torch, voxcpm; print('torch', torch.__version__, '| cuda', torch.cuda.is_available())") "import check"

if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "Installing node dependencies..."
    Push-Location $Root
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed with exit code $LASTEXITCODE"; exit 1 }
    } finally {
        Pop-Location
    }
} else {
    Write-Warning "npm not found; run 'npm install' manually."
}

Write-Host ""
if ($Cpu) {
    Write-Warning "CPU-only setup: set VOXCPM_DEVICE=cpu when running slapslap."
}
Write-Host "Setup complete. Try:"
Write-Host "  npx slapslap sample.mp4"
