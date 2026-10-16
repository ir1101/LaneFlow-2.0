# Builds and deploys the whole LaneFlow stack with one command.
#   .\scripts\deploy.ps1                                   deploy, keeping saved settings
#   .\scripts\deploy.ps1 -Email you@example.com            also subscribe an email address
#   .\scripts\deploy.ps1 -Email you@example.com -EmailOn failures   only failures by email
# Settings given here are saved to samconfig.toml, so later deploys keep them.
param(
    [string]$Email,
    [ValidateSet("all", "failures")][string]$EmailOn = "all"
)

$env:SAM_CLI_TELEMETRY = "0"
Set-Location (Split-Path $PSScriptRoot -Parent)

sam build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed."; exit 1 }

if ($Email) {
    sam deploy --parameter-overrides "NotificationEmail=$Email" "EmailNotifications=$EmailOn" --save-params
} else {
    sam deploy
}
if ($LASTEXITCODE -ne 0) { Write-Error "Deploy failed."; exit 1 }

if ($Email) {
    Write-Host "Check $Email for an AWS confirmation email and click the link to start receiving notifications."
}
