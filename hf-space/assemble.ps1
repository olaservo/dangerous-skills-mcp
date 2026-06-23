# Assemble a self-contained Hugging Face Docker Space bundle for the
# skills-over-mcp adversarial MCP server: server source + vendored corpus +
# Dockerfile + Space README, staged under hf-space/.staging (git-ignored).
#
#   ./assemble.ps1                 # stage into ./.staging
#   ./assemble.ps1 -Staging <dir>  # stage into a custom dir
#
# After staging: `docker build` it locally to validate, or push to an HF Space
# (see ./README.md).
param(
  [string]$Staging
)
$ErrorActionPreference = "Stop"

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here "..")
$corpus   = Join-Path $repoRoot "third_party/dangerous-skills"

if (-not $Staging) { $Staging = Join-Path $here ".staging" }

if (-not (Test-Path (Join-Path $corpus "skills"))) {
  throw "Corpus not found at $corpus/skills - is the vendored corpus present?"
}

# Fresh staging dir.
if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

# Server source (no node_modules - deps are installed in-image from the lockfile).
foreach ($f in @("package.json", "pnpm-lock.yaml", "tsconfig.json")) {
  Copy-Item (Join-Path $repoRoot $f) (Join-Path $Staging $f)
}
Copy-Item (Join-Path $repoRoot "src") (Join-Path $Staging "src") -Recurse

# Vendored corpus (SKILLS_ROOT=/app/skills in the image) + its license (attribution travels).
Copy-Item (Join-Path $corpus "skills") (Join-Path $Staging "skills") -Recurse
Copy-Item (Join-Path $corpus "LICENSE") (Join-Path $Staging "CORPUS_LICENSE")

# Space files: Dockerfile + .dockerignore as-is; README.space.md -> README.md.
Copy-Item (Join-Path $here "Dockerfile") (Join-Path $Staging "Dockerfile")
Copy-Item (Join-Path $here ".dockerignore") (Join-Path $Staging ".dockerignore")
Copy-Item (Join-Path $here "README.space.md") (Join-Path $Staging "README.md")

Write-Host "Staged HF Space bundle at: $Staging"
Write-Host ""
Write-Host "Validate locally:"
Write-Host "  docker build -t skills-over-mcp-space `"$Staging`""
Write-Host "  docker run --rm -e SERVE_PROFILE=--adversarial -p 7860:7860 skills-over-mcp-space"
Write-Host ""
Write-Host "Deploy (after picking name + public/private): see hf-space/README.md"
