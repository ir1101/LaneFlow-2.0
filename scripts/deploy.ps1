# Builds and deploys the whole of LaneFlow, pipeline and website, with one command.
#   .\scripts\deploy.ps1                                   deploy, keeping saved settings
#   .\scripts\deploy.ps1 -Email you@example.com            also subscribe an email address
#   .\scripts\deploy.ps1 -Email you@example.com -EmailOn failures   only failures by email
#   .\scripts\deploy.ps1 -WebOnly                          republish the website files only
# Settings given here are saved to samconfig.toml, so later deploys keep them.
param(
    [string]$Email,
    [ValidateSet("all", "failures")][string]$EmailOn = "all",
    [switch]$WebOnly
)

$region = "ap-southeast-2"
$stack = "laneflow"
$env:SAM_CLI_TELEMETRY = "0"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $WebOnly) {
    sam build
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed."; exit 1 }
    if ($Email) {
        sam deploy --parameter-overrides "NotificationEmail=$Email" "EmailNotifications=$EmailOn" --save-params
    } else {
        sam deploy
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "Deploy failed."; exit 1 }
}

# ---- Website ----
$outputs = aws cloudformation describe-stacks --stack-name $stack --region $region --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
$out = @{}
foreach ($o in $outputs) { $out[$o.OutputKey] = $o.OutputValue }

python scripts/build_web_data.py
if (-not (Test-Path "test-data/broken.pdf")) { python scripts/make_test_pdfs.py | Out-Null }
New-Item -ItemType Directory -Force web/samples | Out-Null
Copy-Item test-data/doc-003p.pdf web/samples/sample-3-pages.pdf
Copy-Item test-data/doc-150p.pdf web/samples/sample-150-pages.pdf
Copy-Item test-data/broken.pdf web/samples/broken.pdf
Copy-Item test-data/not-a-pdf.pdf web/samples/not-a-pdf.pdf

# Pages and scripts are revalidated on every visit; sample files may be cached for a day.
aws s3 sync web "s3://$($out.WebBucketName)" --delete --region $region --only-show-errors --exclude "samples/*" --cache-control "no-cache"
aws s3 sync web/samples "s3://$($out.WebBucketName)/samples" --delete --region $region --only-show-errors --cache-control "max-age=86400"
if ($LASTEXITCODE -ne 0) { Write-Error "Website upload failed."; exit 1 }
aws cloudfront create-invalidation --distribution-id $out.DistributionId --paths "/*" --query "Invalidation.Status" --output text | Out-Null

if ($Email) {
    Write-Host "Check $Email for an AWS confirmation email and click the link to start receiving notifications."
}
Write-Host "Website: $($out.WebsiteUrl)"
