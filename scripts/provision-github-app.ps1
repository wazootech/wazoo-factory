[CmdletBinding()]
param(
  [string]$Code,
  [string]$Organization = "wazootech",
  [string]$AppName = "wazoo-factory-production",
  [string]$ExternalUrl = "https://wazoo-factory.vercel.app",
  [string]$CallbackUrl = "http://localhost:8787/github-app/callback/",
  [string]$SecretDirectory = $env:WAZOO_FACTORY_SECRET_DIR,
  [switch]$Interactive,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

function Invoke-GhJson {
  param([string[]]$Arguments)
  $json = & gh @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gh failed with exit code $LASTEXITCODE"
  }
  return ($json -join "`n" | ConvertFrom-Json)
}

$manifest = [ordered]@{
  name = $AppName
  url = $ExternalUrl
  redirect_url = $CallbackUrl
  hook_attributes = [ordered]@{
    url = "$ExternalUrl/api/github/webhook"
    active = $true
  }
  description = "Approval-gated Wazoo repository delivery factory"
  public = $false
  default_permissions = [ordered]@{
    contents = "write"
    issues = "write"
    pull_requests = "write"
    metadata = "read"
  }
  default_events = @("issues", "pull_request", "push")
}

if (-not $Code) {
  $manifestJson = $manifest | ConvertTo-Json -Compress
  $encoded = [Uri]::EscapeDataString($manifestJson)
  $manifestUrl = "https://github.com/organizations/$Organization/settings/apps/new?manifest=$encoded"
  if (-not $Interactive) {
    Write-Output "Open this URL as an organization owner, approve the app, and copy the one-time code:"
    Write-Output $manifestUrl
    Write-Output "Then rerun this script with -Code <code>."
    exit 0
  }

  $listener = [System.Net.HttpListener]::new()
  $listener.Prefixes.Add("http://localhost:8787/github-app/")
  $listener.Start()
  try {
    Start-Process $manifestUrl
    Write-Output "Waiting for GitHub organization approval in the browser..."
    $task = $listener.GetContextAsync()
    if (-not $task.Wait($TimeoutSeconds * 1000)) {
      throw "Timed out waiting for the GitHub App manifest callback."
    }
    $context = $task.Result
    $Code = $context.Request.QueryString["code"]
    if (-not $Code) {
      throw "GitHub callback did not include an App manifest code."
    }
    $response = [Text.Encoding]::UTF8.GetBytes("GitHub App approval received. You may close this tab.")
    $context.Response.ContentLength64 = $response.Length
    $context.Response.OutputStream.Write($response, 0, $response.Length)
    $context.Response.Close()
  } finally {
    $listener.Stop()
    $listener.Close()
  }
}

if (-not $SecretDirectory) {
  throw "Set WAZOO_FACTORY_SECRET_DIR or pass -SecretDirectory outside the repository before converting the app."
}

if (-not (Test-Path -LiteralPath $SecretDirectory)) {
  throw "Secret directory does not exist: $SecretDirectory"
}

$conversion = Invoke-GhJson @(
  "api",
  "--method", "POST",
  "app-manifests/$Code/conversions",
  "--header", "Accept: application/vnd.github+json",
  "--header", "X-GitHub-Api-Version: 2022-11-28"
)

$metadata = [ordered]@{
  appId = $conversion.id
  slug = $conversion.slug
  clientId = $conversion.client_id
  owner = $Organization
  repositorySelection = "selected"
  permissions = $manifest.default_permissions
}

$metadataPath = Join-Path $SecretDirectory "github-app.json"
$pemPath = Join-Path $SecretDirectory "github-app.private-key.pem"
$webhookPath = Join-Path $SecretDirectory "github-app.webhook-secret"

$metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
$conversion.pem | Set-Content -LiteralPath $pemPath -Encoding ASCII -NoNewline
if ($conversion.webhook_secret) {
  $conversion.webhook_secret | Set-Content -LiteralPath $webhookPath -Encoding ASCII -NoNewline
}

Write-Output "GitHub App provisioned: $($conversion.slug)"
Write-Output "Metadata: $metadataPath"
Write-Output "Private key: $pemPath"
if ($conversion.webhook_secret) {
  Write-Output "Webhook secret: $webhookPath"
}
Write-Output "Install the app on the selected repositories before enabling mutations."
