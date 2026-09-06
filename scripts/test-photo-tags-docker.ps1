param([string]$ContainerName = 'supabase_db_ppiymmsurabwxnzpdasl')
$ErrorActionPreference = 'Stop'
if ($ContainerName -notmatch '^supabase_db_[a-zA-Z0-9_-]+$') { throw 'Expected a local Supabase database container name.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerHost = 'npipe:////./pipe/docker_engine'
$exists = & docker --host $dockerHost exec $ContainerName psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "select to_regclass('public.photo_person_tags') is not null"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local Docker PostgreSQL.' }
function Read-TransactionBody([string]$RelativePath) {
  $content = [IO.File]::ReadAllText((Join-Path $repoRoot $RelativePath))
  $content = [regex]::Replace($content, '(?i)^\s*begin;\s*', '')
  return [regex]::Replace($content, '(?i)(commit|rollback);\s*$', '')
}
$parts = @("begin; set local lock_timeout='5s'; set local statement_timeout='60s';")
if (($exists | Out-String).Trim() -eq 'f') {
  $parts += Read-TransactionBody 'supabase/migrations/202609050003_attachment_reference_uniqueness.sql'
  $parts += Read-TransactionBody 'supabase/migrations/202609060001_photo_person_tags.sql'
}
$parts += Read-TransactionBody 'supabase/tests/photo_person_tags_test.sql'
$parts += 'rollback;'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$result = ($parts -join "`n") | & docker --host $dockerHost exec -i $ContainerName psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 2>&1
$exitCode = $LASTEXITCODE
$result | ForEach-Object { Write-Output $_ }
if ($exitCode -ne 0 -or ($result -match '^not ok' -or $result -match 'Looks like you')) { throw 'Photo tag database tests failed; the transaction was rolled back.' }
Write-Output 'Docker PostgreSQL tests passed. Only changes made by this test transaction were rolled back; previously applied migrations and demo data remain.'
