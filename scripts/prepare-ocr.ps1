param([string] $Proxy = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $root 'build/ocr'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$dependencies = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ocr-dependencies.json') -Raw | ConvertFrom-Json
foreach ($dependency in $dependencies) {
    $path = Join-Path $cache $dependency.name
    if ((Test-Path -LiteralPath $path) -and
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $dependency.sha256) { continue }
    $options = @{ Uri = $dependency.url; OutFile = $path; TimeoutSec = 120 }
    if ($Proxy) { $options.Proxy = $Proxy }
    Invoke-WebRequest @options
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $dependency.sha256) {
        throw "OCR dependency checksum mismatch: $($dependency.name)"
    }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $cache 'tesseract4android-4.9.0.aar'), (Join-Path $cache 'library'), $true)
