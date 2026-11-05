param(
  [string]$OutputDirectory = (Join-Path $env:TEMP 'CraftMate-release')
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
$payloadPath = Join-Path $OutputDirectory 'app_payload.zip'
$setupPath = Join-Path $OutputDirectory 'CraftMate_Setup.exe'
$uninstallPath = Join-Path $OutputDirectory 'Uninstall.exe'

foreach ($required in @('node.exe', 'CraftMate.exe')) {
  if (-not (Test-Path (Join-Path $projectRoot $required))) {
    throw "Required release file is missing: $required"
  }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
npm run build --prefix $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path $compiler)) { throw 'The .NET Framework C# compiler was not found.' }
& $compiler /nologo /target:winexe "/out:$uninstallPath" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'Uninstall.cs')
if ($LASTEXITCODE -ne 0) { throw 'Uninstaller compilation failed.' }
& $compiler /nologo /target:winexe "/out:$setupPath" "/resource:$uninstallPath,CraftMate.Uninstall.exe" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$fileStream = [System.IO.File]::Open($payloadPath, [System.IO.FileMode]::Create)
try {
  $archive = [System.IO.Compression.ZipArchive]::new($fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    $addFile = {
      param([string]$SourcePath, [string]$ArchivePath)
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $SourcePath, $ArchivePath, [System.IO.Compression.CompressionLevel]::Fastest
      ) | Out-Null
    }
    $addDirectory = {
      param([string]$SourceDirectory, [string]$ArchivePrefix)
      $base = (Resolve-Path $SourceDirectory).Path.TrimEnd('\') + '\'
      foreach ($file in Get-ChildItem -LiteralPath $SourceDirectory -File -Recurse -Force) {
        $relative = $file.FullName.Substring($base.Length).Replace('\', '/')
        & $addFile $file.FullName "$ArchivePrefix/$relative"
      }
    }

    foreach ($directory in @('dist', 'public', 'node_modules')) {
      & $addDirectory (Join-Path $projectRoot $directory) $directory
    }
    foreach ($file in @('CraftMate.exe', 'node.exe', '.env.example', 'package.json', 'package-lock.json', 'README.md')) {
      & $addFile (Join-Path $projectRoot $file) $file
    }
    & $addFile $uninstallPath 'Uninstall.exe'
  } finally {
    $archive.Dispose()
  }
} finally {
  $fileStream.Dispose()
}

$check = [System.IO.Compression.ZipFile]::OpenRead($payloadPath)
try {
  if ($check.Entries.FullName -contains '.env' -or $check.Entries.FullName -match '^\.appdata/') {
    throw 'The payload contains a local environment file or browser cache.'
  }
} finally {
  $check.Dispose()
}

Write-Output "Built release $($version): $setupPath, $uninstallPath, and $payloadPath"
