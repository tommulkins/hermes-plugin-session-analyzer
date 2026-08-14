# Install Hermes Session Analyzer (desktop plugin + backend) on Windows.
# Idempotent: safe to re-run after updates; never duplicates config entries.
# Usage (PowerShell):
#   git clone https://github.com/tommulkins/hermes-plugin-session-analyzer.git
#   cd hermes-plugin-session-analyzer
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# NOTE: this file must stay pure ASCII (no checkmarks, arrows, or curly
# quotes). Windows PowerShell 5.1 reads BOM-less files as ANSI and chokes
# on multi-byte UTF-8 sequences (ParserError: Unexpected token '}').

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

Write-Host "-> Installing Session Analyzer into $hermesHome"

# 1. Desktop JS plugin (hot-reloads; no restart needed for the UI side)
$desktopTarget = Join-Path $hermesHome "desktop-plugins\$pluginId"
New-Item -ItemType Directory -Force -Path $desktopTarget | Out-Null
Copy-Item -Force (Join-Path $srcDir "desktop-plugins\$pluginId\plugin.js") (Join-Path $desktopTarget 'plugin.js')
Write-Host "  [x] desktop-plugins\$pluginId\plugin.js"

# 2. Python backend (mounted at the next Hermes Desktop restart)
$backendTarget = Join-Path $hermesHome "plugins\$pluginId\dashboard"
New-Item -ItemType Directory -Force -Path $backendTarget | Out-Null
Copy-Item -Force (Join-Path $srcDir "plugins\$pluginId\dashboard\manifest.json") $backendTarget
Copy-Item -Force (Join-Path $srcDir "plugins\$pluginId\dashboard\plugin_api.py") $backendTarget
Write-Host "  [x] plugins\$pluginId\dashboard\{manifest.json,plugin_api.py}"

# 3. Enable in config.yaml (plugins.enabled) if not already listed
$entry = "    - $pluginId"
if (-not (Test-Path $config)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $config) | Out-Null
    Set-Content -Path $config -Value "plugins:`n  enabled:`n$entry"
    Write-Host "  [x] created config.yaml with $pluginId enabled"
} else {
    $lines = Get-Content -Path $config
    if ($lines -contains $entry) {
        Write-Host "  [x] $pluginId already enabled"
    } else {
        # Insert only inside the plugins: block (port of the install.sh awk
        # fix 00f07aa). Track section state: a top-level (unindented) key
        # other than "plugins:" ends the plugins section, so a stray
        # "checkpoints:\n  enabled:" earlier in the file is NOT matched.
        $inPlugins = $false
        $inEnabledList = $false
        $inserted = $false
        $newLines = New-Object System.Collections.Generic.List[string]
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $l = $lines[$i]
            $next = if ($i + 1 -lt $lines.Count) { $lines[$i + 1] } else { '' }
            if ($l -match '^plugins:') {
                $inPlugins = $true
                $newLines.Add($l)
                continue
            }
            # Top-level key (no leading whitespace) that is not "plugins:".
            if ($inPlugins -and $l -match '^[^ \t]' -and $l -notmatch '^plugins:') {
                $inPlugins = $false
                $inEnabledList = $false
            }
            if ($inPlugins -and -not $inserted) {
                if ($l -match '^  enabled:') {
                    if ($l -match '\[\s*\]') {
                        # Inline empty list: "enabled: []" -> "enabled:" + entry
                        $newLines.Add('  enabled:')
                        $newLines.Add($entry)
                        $inserted = $true
                    } elseif ($next -match '^    - ') {
                        # Siblings follow; insert after the last list item.
                        $newLines.Add($l)
                        $inEnabledList = $true
                    } else {
                        # Empty list or nothing after: insert right away.
                        $newLines.Add($l)
                        $newLines.Add($entry)
                        $inserted = $true
                    }
                    continue
                }
                if ($inEnabledList -and $l -match '^    - ') {
                    $newLines.Add($l)
                    if ($next -notmatch '^    - ') {
                        $newLines.Add($entry)
                        $inserted = $true
                    }
                    continue
                }
            }
            $newLines.Add($l)
        }
        if ($inserted) {
            Set-Content -Path $config -Value $newLines
            Write-Host "  [x] added $pluginId to plugins.enabled in config.yaml"
        } else {
            # No plugins: section or no enabled: under it - append a block.
            Add-Content -Path $config -Value "`nplugins:`n  enabled:`n$entry"
            Write-Host "  [x] added plugins.enabled block to config.yaml"
        }
    }
}

Write-Host ""
Write-Host "Done. Restart Hermes Desktop once so the backend mounts:"
Write-Host "  Quit Hermes Desktop and reopen it."
Write-Host ""
Write-Host "Then open it via:"
Write-Host "  * Sidebar 'Session Analyzer' row (graph icon)"
Write-Host "  * Ctrl+K -> 'Session Analyzer: Open'"
