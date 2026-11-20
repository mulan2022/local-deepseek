param(
    [Parameter(Mandatory)] [string] $Jdk,
    [Parameter(Mandatory)] [string] $BuildTools,
    [Parameter(Mandatory)] [string] $AndroidJar,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$')] [string] $OutputName
)

$ErrorActionPreference = 'Stop'
$Jdk = (Resolve-Path -LiteralPath $Jdk).Path
$BuildTools = (Resolve-Path -LiteralPath $BuildTools).Path
$AndroidJar = (Resolve-Path -LiteralPath $AndroidJar).Path
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$apkName = if ($OutputName) { $OutputName } else { "Singula-$version.apk" }
$android = Join-Path $root 'android'
$build = Join-Path $root 'build'
$env:JAVA_HOME = $Jdk
$env:Path = "$Jdk\bin;$env:Path"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "deepseek-apk-$([Guid]::NewGuid().ToString('N'))"

function Invoke-BuildTool {
    param([string] $Executable, [string[]] $Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable exited with code $LASTEXITCODE"
    }
}

Push-Location $root
try {
    New-Item -ItemType Directory -Path $build -Force | Out-Null
    & (Join-Path $PSScriptRoot 'prepare-ocr.ps1')
    $ocr = Join-Path $build 'ocr'
    $assets = Join-Path $staging 'assets'
    $classes = Join-Path $staging 'classes'
    $dex = Join-Path $staging 'dex'
    New-Item -ItemType Directory -Path $assets, $classes, $dex -Force | Out-Null
    $web = Join-Path $assets 'web'
    Invoke-BuildTool 'pnpm.cmd' @('build')
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $web -Recurse
    $ocrAssets = Join-Path $assets 'ocr'
    New-Item -ItemType Directory -Path $ocrAssets -Force | Out-Null
    Copy-Item -LiteralPath "$ocr/chi_sim.traineddata", "$ocr/eng.traineddata" -Destination $ocrAssets
    Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination $ocrAssets
    Copy-Item -LiteralPath (Join-Path $android 'ocr-licenses') -Destination $ocrAssets -Recurse
    # Keep the Windows resource tools, their working directory, and their arguments
    # off the non-ASCII project path.
    Copy-Item -LiteralPath "$android\res", "$android\AndroidManifest.xml", $AndroidJar -Destination $staging -Recurse
    Copy-Item -LiteralPath "$BuildTools\aapt2.exe", "$BuildTools\zipalign.exe" -Destination $staging
    $platformName = Split-Path $AndroidJar -Leaf
    $platform = Join-Path $staging $platformName

    $aapt2 = Join-Path $staging 'aapt2.exe'
    $generated = Join-Path $staging 'generated'
    $unsigned = Join-Path $staging 'unsigned.apk'
    $aligned = Join-Path $staging 'aligned.apk'
    $output = Join-Path $staging $apkName
    Push-Location $staging
    try {
        Invoke-BuildTool $aapt2 @('compile', '--dir', 'res', '-o', 'resources.zip')
        Invoke-BuildTool $aapt2 @('link', '-I', $platformName, '--manifest', 'AndroidManifest.xml',
            '--java', 'generated', '-o', 'unsigned.apk', 'resources.zip')
    } finally {
        Pop-Location
    }

    $sources = @(Get-ChildItem -LiteralPath (Join-Path $android 'src'), $generated -Recurse -File -Filter '*.java' |
        ForEach-Object FullName)
    Invoke-BuildTool "$Jdk\bin\javac.exe" (@('--release', '8', '-encoding', 'UTF-8',
        '-classpath', "$platform;$ocr/library/classes.jar", '-d', $classes) + $sources)
    $classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -File -Filter '*.class' |
        ForEach-Object FullName)
    Invoke-BuildTool "$Jdk\bin\java.exe" (@('-cp', "$BuildTools\lib\d8.jar",
        'com.android.tools.r8.D8', '--min-api', '26', '--lib', $platform, '--output', $dex, "$ocr/library/classes.jar") + $classFiles)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
    try {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, "$dex\classes.dex", 'classes.dex') | Out-Null
        $jniRoot = Join-Path $ocr 'library/jni'
        foreach ($native in Get-ChildItem -LiteralPath $jniRoot -Recurse -File -Filter '*.so') {
            $name = 'lib/' + [IO.Path]::GetRelativePath($jniRoot, $native.FullName).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $native.FullName, $name) | Out-Null
        }
        foreach ($file in Get-ChildItem -LiteralPath $assets -Recurse -File) {
            $name = [System.IO.Path]::GetRelativePath($staging, $file.FullName).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $name) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
    Push-Location $staging
    try {
        Invoke-BuildTool "$staging\zipalign.exe" @('-f', '4', 'unsigned.apk', 'aligned.apk')
    } finally {
        Pop-Location
    }

    $key = Join-Path $build 'debug.keystore'
    if (-not (Test-Path -LiteralPath $key)) {
        Invoke-BuildTool "$Jdk\bin\keytool.exe" @('-genkeypair', '-keystore', $key, '-storepass', 'android',
            '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048',
            '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US')
    }
    $signer = Join-Path $BuildTools 'lib\apksigner.jar'
    Invoke-BuildTool "$Jdk\bin\java.exe" @('-jar', $signer, 'sign', '--ks', $key,
        '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', $output, $aligned)
    Invoke-BuildTool "$Jdk\bin\java.exe" @('-jar', $signer, 'verify', '--verbose', $output)
    Copy-Item -LiteralPath $output -Destination $build -Force
    Get-Item -LiteralPath (Join-Path $build $apkName)
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $staging) {
        $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $resolved = (Resolve-Path -LiteralPath $staging).Path
        if ($resolved.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase) -and
                (Split-Path $resolved -Leaf) -match '^deepseek-apk-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
