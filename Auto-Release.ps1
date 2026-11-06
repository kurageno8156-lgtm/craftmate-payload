[CmdletBinding()]
param(
    [string]$Version,
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump = 'patch',
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path $PSScriptRoot).Path
Set-Location $projectRoot

foreach ($tool in @('git', 'gh', 'npm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Required command was not found: $tool"
    }
}

function Get-CommandOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $output = @(& $Command @Arguments)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw $FailureMessage
    }

    if ($null -eq $output) {
        return ''
    }
    return (($output -join [Environment]::NewLine).Trim())
}

$repo = Get-CommandOutput -Command 'gh' -Arguments @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner') -FailureMessage 'Could not identify the GitHub repository. Run this script inside an authenticated Git checkout.'
if ([string]::IsNullOrWhiteSpace($repo)) {
    throw 'Could not identify the GitHub repository. Run this script inside an authenticated Git checkout.'
}
$defaultBranch = Get-CommandOutput -Command 'gh' -Arguments @('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name') -FailureMessage 'Could not identify the GitHub default branch.'
if ([string]::IsNullOrWhiteSpace($defaultBranch)) {
    throw 'Could not identify the GitHub default branch.'
}

$branch = Get-CommandOutput -Command 'git' -Arguments @('branch', '--show-current') -FailureMessage 'Could not determine the current Git branch.'
if ([string]::IsNullOrWhiteSpace($branch) -or $branch -ne $defaultBranch) {
    throw "Switch to the repository default branch ($defaultBranch) before creating a release."
}

$packagePath = Join-Path $projectRoot 'package.json'
$lockPath = Join-Path $projectRoot 'package-lock.json'
$setupSourcePath = Join-Path $projectRoot 'installer\Setup.cs'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$currentVersion = if ($null -ne $package -and $null -ne $package.version) { [string]$package.version } else { '' }
if ([string]::IsNullOrWhiteSpace($currentVersion) -or $currentVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "package.json has an invalid release version: $currentVersion"
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $parts = $currentVersion.Split('.') | ForEach-Object { [int]$_ }
    switch ($Bump) {
        'major' { $Version = '{0}.0.0' -f ($parts[0] + 1) }
        'minor' { $Version = '{0}.{1}.0' -f $parts[0], ($parts[1] + 1) }
        default { $Version = '{0}.{1}.{2}' -f $parts[0], $parts[1], ($parts[2] + 1) }
    }
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must use the format major.minor.patch: $Version"
}
if ([version]$Version -lt [version]$currentVersion) {
    throw "Release version $Version cannot be lower than current version $currentVersion."
}

$tag = "v$Version"
$existingTag = Get-CommandOutput -Command 'git' -Arguments @('tag', '--list', $tag) -FailureMessage "Could not check whether Git tag exists: $tag"
if (-not [string]::IsNullOrWhiteSpace($existingTag)) {
    throw "Git tag already exists locally: $tag"
}
$remoteTag = & git ls-remote --tags origin "refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { throw 'Could not check remote Git tags.' }
if (-not [string]::IsNullOrWhiteSpace(($remoteTag -join ''))) {
    throw "Git tag already exists on origin: $tag"
}

$lockText = [System.IO.File]::ReadAllText($lockPath)
$lockPattern = '(?m)^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$packageText = [System.IO.File]::ReadAllText($packagePath)
$packagePattern = '(?m)^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$'
$packageText = ([regex]::new($packagePattern)).Replace($packageText, ('${1}' + $Version + '${2}'), 1)
$lockText = ([regex]::new($lockPattern)).Replace($lockText, ('${1}' + $Version + '${2}'), 2)
if ($packageText -notmatch ('"version"\s*:\s*"' + [regex]::Escape($Version) + '"')) {
    throw 'Could not update package.json version.'
}
$lockRootVersions = [regex]::Matches($lockText, '(?m)^\s*"version"\s*:\s*"' + [regex]::Escape($Version) + '"')
if ($lockRootVersions.Count -lt 2) { throw 'Could not update the root package-lock.json versions.' }

$setupText = [System.IO.File]::ReadAllText($setupSourcePath)
$setupText = ([regex]::new('(private const string CurrentVersion\s*=\s*")[^"]+(";)')).Replace(
    $setupText,
    ('${1}' + $Version + '${2}'),
    1
)
$setupText = ([regex]::new('(private const string DownloadUrl\s*=\s*"https://github\.com/[^/]+/[^/]+/releases/download/v)[^/]+(/app_payload\.zip";)')).Replace(
    $setupText,
    ('${1}' + $Version + '${2}'),
    1
)
if ($setupText -notmatch ('CurrentVersion\s*=\s*"' + [regex]::Escape($Version) + '"')) {
    throw 'Could not update Setup.cs CurrentVersion.'
}
if ($setupText -notmatch ('releases/download/v' + [regex]::Escape($Version) + '/app_payload\.zip')) {
    throw 'Could not update Setup.cs payload download URL.'
}

[System.IO.File]::WriteAllText($packagePath, $packageText, $utf8NoBom)
[System.IO.File]::WriteAllText($lockPath, $lockText, $utf8NoBom)
[System.IO.File]::WriteAllText($setupSourcePath, $setupText, $utf8NoBom)

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $env:TEMP ("CraftMate-release-$Version-" + [guid]::NewGuid().ToString('N'))
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$buildScript = Join-Path $projectRoot 'installer\Build-Release.ps1'
& $buildScript -OutputDirectory $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }

$setupPath = Join-Path $OutputDirectory 'CraftMate_Setup.exe'
$uninstallerPath = Join-Path $OutputDirectory 'Uninstall.exe'
$payloadPath = Join-Path $OutputDirectory 'app_payload.zip'
foreach ($artifact in @($setupPath, $uninstallerPath, $payloadPath)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf) -or (Get-Item -LiteralPath $artifact).Length -eq 0) {
        throw "Release artifact is missing or empty: $artifact"
    }
}

Copy-Item -LiteralPath $setupPath -Destination (Join-Path $projectRoot 'CraftMate_Setup.exe') -Force
Copy-Item -LiteralPath $uninstallerPath -Destination (Join-Path $projectRoot 'Uninstall.exe') -Force

git add -- Auto-Release.ps1 package.json package-lock.json installer\Build-Release.ps1 installer\Setup.cs installer\Uninstall.cs Uninstall.exe src public
if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }
git diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
    git commit -m "Release $tag"
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed.' }
} elseif ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect the staged changes.'
}
git push origin $defaultBranch
if ($LASTEXITCODE -ne 0) { throw 'git push failed. The local release commit was kept.' }

$notes = "CraftMate $tag release`n`n- Built the Windows setup and application payload.`n- Includes the current dashboard and installer updates.`n"
gh release create $tag $setupPath $payloadPath --repo $repo --target $defaultBranch --title "CraftMate Setup $tag" --notes $notes
if ($LASTEXITCODE -ne 0) { throw "GitHub release creation failed. The version commit was pushed; retry with -Version $Version after resolving the release error." }

Write-Output "Released $tag to $repo"
Write-Output "Setup: $setupPath"
Write-Output "Payload: $payloadPath"
