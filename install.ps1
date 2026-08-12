# Install Hermes Session Stats (desktop plugin + backend) on Windows.
# Idempotent: safe to re-run after updates; never duplicates config entries.
# Usage (PowerShell):
#   git clone https://github.com/tommulkins/hermes-plugin-session-analyzer.git
#   cd hermes-plugin-session-analyzer
#   powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'

# Resolve HERMES_HOME the same way Hermes Desktop does (electron/main.ts):
# 1. $env:HERMES_HOME wins if set
# 2. Legacy ~\.hermes wins if LOCALAPPDATA install doesn't exist yet
# 3. Otherwise %LOCALAPPDATA%\hermes
$pluginId = 'session-dashboard'

function Resolve-HermesHome {
    if ($env:HERMES_HOME -and $env:HERMES_HOME.Trim() -ne '') {
        return $env:HERMES_HOME.Trim()
    }
    $localAppData = Join-Path $env:LOCALAPPDATA 'hermes'
    $legacy = Join-Path $HOME '.hermes'
    if (-not (Test-Path $localAppData) -and (Test-Path $legacy)) {
        return $legacy
    }
    return $localAppData
}

$hermesHome = Resolve-HermesHome
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Join-Path $hermesHome 'config.yaml'

Write-Host "→ Installing Session Stats into $hermesHome"

# 1. Desktop JS plugin (hot-reloads; no restart needed for the UI side)
$desktopTarget = Join-Path $hermesHome "desktop-plugins\$pluginId"
New-Item -ItemType Directory -Force -Path $desktopTarget | Out-Null
Copy-Item -Force (Join-Path $srcDir "desktop-plugins\$pluginId\plugin.js") (Join-Path $desktopTarget 'plugin.js')
Write-Host "  ✓ desktop-plugins\$pluginId\plugin.js"

# 2. Python backend (mounted at the next Hermes Desktop restart)
$backendTarget = Join-Path $hermesHome "plugins\$pluginId\dashboard"
New-Item -ItemType Directory -Force -Path $backendTarget | Out-Null
Copy-Item -Force (Join-Path $srcDir "plugins\$pluginId\dashboard\manifest.json") $backendTarget
Copy-Item -Force (Join-Path $srcDir "plugins\$pluginId\dashboard\plugin_api.py") $backendTarget
Write-Host "  ✓ plugins\$pluginId\dashboard\{manifest.json,plugin_api.py}"

# 3. Enable in config.yaml (plugins.enabled) if not already listed
$entry = "    - $pluginId"
if (-not (Test-Path $config)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $config) | Out-Null
    Set-Content -Path $config -Value "plugins:`n  enabled:`n$entry"
    Write-Host "  ✓ created config.yaml with $pluginId enabled"
} else {
    $lines = Get-Content -Path $config
    if ($lines -contains $entry) {
        Write-Host "  ✓ $pluginId already enabled"
    } else {
        # Insert right after the first "  enabled:" line; append a block if
        # the file has no plugins/enabled structure at all.
        $idx = [Array]::FindIndex($lines, [Predicate[string]]{ param($l) $l -match '^  enabled:' })
        if ($idx -ge 0) {
            $newLines = New-Object System.Collections.Generic.List[string]
            for ($i = 0; $i -lt $lines.Count; $i++) {
                $newLines.Add($lines[$i])
                if ($i -eq $idx) { $newLines.Add($entry) }
            }
            Set-Content -Path $config -Value $newLines
            Write-Host "  ✓ added $pluginId to plugins.enabled in config.yaml"
        } else {
            Add-Content -Path $config -Value "`nplugins:`n  enabled:`n$entry"
            Write-Host "  ✓ added plugins.enabled block to config.yaml"
        }
    }
}

Write-Host ""
Write-Host "Done. Restart Hermes Desktop once so the backend mounts:"
Write-Host "  Quit Hermes Desktop and reopen it."
Write-Host ""
Write-Host "Then open it via:"
Write-Host "  • Sidebar → “Session Stats” row (graph icon)"
Write-Host "  • ⌘K / Ctrl+K → “Session Stats: Open”"
