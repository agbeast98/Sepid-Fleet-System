param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$BackupFile,

    [string]$PostgresImage = 'postgres:16-alpine'
)

$ErrorActionPreference = 'Stop'
$backupPath = (Resolve-Path -LiteralPath $BackupFile).Path
$containerName = 'sepid-restore-check-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$restorePassword = [guid]::NewGuid().ToString('N')
$containerStarted = $false

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
}

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI was not found. Install Docker and start its engine, then retry.'
    }

    Invoke-Docker run --detach --network none --name $containerName --env "POSTGRES_PASSWORD=$restorePassword" $PostgresImage
    $containerStarted = $true

    Invoke-Docker cp $backupPath "${containerName}:/tmp/sepid-backup.dump"

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        & docker exec $containerName pg_isready -U postgres -d postgres *> $null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        throw 'The temporary PostgreSQL instance did not become ready within 60 seconds.'
    }

    & docker exec --env "PGPASSWORD=$restorePassword" $containerName pg_restore --exit-on-error --no-owner --no-acl --username=postgres --dbname=postgres /tmp/sepid-backup.dump
    if ($LASTEXITCODE -ne 0) {
        throw "Backup restore failed with exit code $LASTEXITCODE."
    }

    $schemaCheck = & docker exec --env "PGPASSWORD=$restorePassword" $containerName psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atc "SELECT (to_regclass('public.machines') IS NOT NULL)::text || ' ' || (to_regclass('public.repairs') IS NOT NULL)::text || ' ' || (to_regclass('public.users') IS NOT NULL)::text || ' ' || (to_regclass('public.app_settings') IS NOT NULL)::text"
    if ($LASTEXITCODE -ne 0 -or $schemaCheck.Trim() -ne 'true true true true') {
        throw 'The backup restored, but one or more required fleet tables are missing.'
    }

    $counts = & docker exec --env "PGPASSWORD=$restorePassword" $containerName psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atc "SELECT 'machines='||(SELECT count(*) FROM machines)||' repairs='||(SELECT count(*) FROM repairs)||' users='||(SELECT count(*) FROM users)"
    if ($LASTEXITCODE -ne 0) {
        throw 'The backup restored, but table counts could not be read.'
    }

    Write-Output 'Backup restore check passed in an isolated PostgreSQL container.'
    Write-Output $counts
}
finally {
    if ($containerStarted) {
        & docker rm --force $containerName *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not remove temporary container $containerName. Remove it manually after checking it is the disposable restore-check container."
        }
    }
}
