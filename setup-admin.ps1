$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'backend')
try {
    if (!(Test-Path -LiteralPath '.env')) { throw 'Run dev.bat once to initialize the development environment.' }
    npm.cmd run migrate
    if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }

    $env:SEPID_ADMIN_USERNAME = Read-Host 'Administrator username'
    if (!$env:SEPID_ADMIN_USERNAME.Trim()) { throw 'Enter a username.' }
    $fleetSecret = Read-Host 'Administrator password (12 or more characters)' -AsSecureString
    $fleetPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($fleetSecret)
    try {
        $env:SEPID_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($fleetPointer)
        node --env-file=.env dist/main.js --bootstrap-admin
        if ($LASTEXITCODE -ne 0) { throw 'Administrator setup failed.' }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($fleetPointer)
        Remove-Item Env:SEPID_ADMIN_USERNAME, Env:SEPID_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}
