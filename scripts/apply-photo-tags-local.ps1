$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerHost = 'npipe:////./pipe/docker_engine'
$container = 'supabase_db_ppiymmsurabwxnzpdasl'
$versions = & docker --host $dockerHost exec $container psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c 'select version from supabase_migrations.schema_migrations'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local Supabase migration registry.' }
# Only the photo feature and its attachment-identity prerequisite are applied.
$files = @('202609050003_attachment_reference_uniqueness.sql', '202609060001_photo_person_tags.sql')
$parts = @("begin; set local lock_timeout='5s'; set local statement_timeout='60s';")
foreach ($file in $files) {
  $version = $file.Split('_')[0]
  if ($versions -contains $version) { Write-Output "Already applied locally: $version"; continue }
  $body = [IO.File]::ReadAllText((Join-Path $repoRoot "supabase/migrations/$file"))
  $body = [regex]::Replace($body, '(?i)^\s*begin;\s*', '')
  $body = [regex]::Replace($body, '(?i)commit;\s*$', '')
  $parts += $body
  $name = $file.Substring($version.Length + 1).Replace('.sql', '')
  $escapedBody = $body.Replace("'", "''")
  $parts += "insert into supabase_migrations.schema_migrations(version,name,statements) values('$version','$name',array['$escapedBody']);"
}
$parts += 'commit;'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
($parts -join "`n") | & docker --host $dockerHost exec -i $container psql -U postgres -d postgres -X -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Local migration failed.' }
Write-Output 'Photo-tag migrations applied to local Docker PostgreSQL only.'
