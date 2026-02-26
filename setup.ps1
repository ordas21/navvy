# Navvy Setup — Windows (PowerShell)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== Navvy Setup (Windows) ===" -ForegroundColor Cyan

# Check prerequisites
Write-Host "`nChecking prerequisites..."

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed. Install Node 18+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}
$nodeVersion = (node --version)
Write-Host "  Node.js $nodeVersion"

# npm
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: npm is not found. It should come with Node.js." -ForegroundColor Red
    exit 1
}
Write-Host "  npm $(npm --version)"

# Claude CLI
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "WARNING: Claude CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-cli" -ForegroundColor Yellow
} else {
    Write-Host "  Claude CLI found"
}

# Install dependencies
Write-Host "`nInstalling npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { exit 1 }

# Build TypeScript
Write-Host "Building TypeScript..."
npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Usage:"
Write-Host "  1. Launch Chrome with remote debugging:"
Write-Host '     & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-debug-profile" --no-first-run'
Write-Host "  2. Start the server: npm run dev"
Write-Host "  3. Load extension in chrome://extensions (developer mode, load unpacked 'extension/')"
Write-Host "  4. Open the side panel and start chatting!"
