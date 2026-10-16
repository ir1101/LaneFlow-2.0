# Deletes the whole LaneFlow stack with one command.
# CloudFormation cannot delete a bucket that still holds files, so all three buckets are
# emptied first. Everything else (functions, queues, table, logs, alarms, dashboard, API,
# CloudFront) is removed by deleting the stack. Deleting the CloudFront distribution is
# the slow part: allow about 10 minutes.
$region = "ap-southeast-2"
$stack = "laneflow"
$env:SAM_CLI_TELEMETRY = "0"
Set-Location (Split-Path $PSScriptRoot -Parent)

$account = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { Write-Error "Not signed in to AWS. Run: aws login"; exit 1 }

foreach ($bucket in "laneflow-uploads-$account-$region", "laneflow-curated-$account-$region", "laneflow-web-$account-$region") {
    aws s3api head-bucket --bucket $bucket --region $region 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Emptying $bucket"
        aws s3 rm "s3://$bucket" --recursive --region $region --only-show-errors
        if ($LASTEXITCODE -ne 0) { Write-Error "Could not empty $bucket."; exit 1 }
    }
}

# The memory-tuning stack is separate and optional; remove it first if it exists.
aws cloudformation describe-stacks --stack-name "$stack-tuning" --region $region 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Removing the memory-tuning stack"
    sam delete --stack-name "$stack-tuning" --region $region --no-prompts
}

sam delete --stack-name $stack --region $region --no-prompts
if ($LASTEXITCODE -ne 0) { Write-Error "Stack deletion failed."; exit 1 }

aws cloudformation describe-stacks --stack-name $stack --region $region 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Error "Stack still exists."; exit 1 }
Write-Host "LaneFlow has been removed."
