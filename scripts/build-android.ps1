param(
    [Parameter(Mandatory)] [string] $Jdk,
    [Parameter(Mandatory)] [string] $BuildTools,
    [Parameter(Mandatory)] [string] $AndroidJar
)

$ErrorActionPreference = 'Stop'
$Jdk = (Resolve-Path -LiteralPath $Jdk).Path
$BuildTools = (Resolve-Path -LiteralPath $BuildTools).Path
$AndroidJar = (Resolve-Path -LiteralPath $AndroidJar).Path
$root = Split-Path -Parent $PSScriptRoot
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
    $assets = Join-Path $staging 'assets'
    $classes = Join-Path $staging 'classes'
    $dex = Join-Path $staging 'dex'
    New-Item -ItemType Directory -Path $assets, $classes, $dex -Force | Out-Null
    $web = Join-Path $assets 'web'
    Invoke-BuildTool 'pnpm.cmd' @('build')
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $web -Recurse
    # aapt2 on Windows can fail to open inputs from non-ASCII workspace paths.
    Copy-Item -LiteralPath "$android\res", "$android\AndroidManifest.xml", $AndroidJar -Destination $staging -Recurse
    $platform = Join-Path $staging (Split-Path $AndroidJar -Leaf)

    $aapt2 = Join-Path $BuildTools 'aapt2.exe'
    $resources = Join-Path $staging 'resources.zip'
    $unsigned = Join-Path $staging 'unsigned.apk'
    $aligned = Join-Path $staging 'aligned.apk'
    $output = Join-Path $staging 'DeepSeek-Local-Chat.apk'
    Invoke-BuildTool $aapt2 @('compile', '--dir', "$staging\res", '-o', $resources)
    Invoke-BuildTool $aapt2 @('link', '-I', $platform, '--manifest', "$staging\AndroidManifest.xml",
        '-o', $unsigned, $resources)

    $source = Join-Path $android 'src\local\deepseek\chat\MainActivity.java'
    Invoke-BuildTool "$Jdk\bin\javac.exe" @('--release', '8', '-encoding', 'UTF-8',
        '-classpath', $platform, '-d', $classes, $source)
    $classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -File -Filter '*.class' |
        ForEach-Object FullName)
    Invoke-BuildTool "$Jdk\bin\java.exe" (@('-cp', "$BuildTools\lib\d8.jar",
        'com.android.tools.r8.D8', '--min-api', '26', '--lib', $platform, '--output', $dex) + $classFiles)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
    try {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, "$dex\classes.dex", 'classes.dex') | Out-Null
        foreach ($file in Get-ChildItem -LiteralPath $assets -Recurse -File) {
            $name = [System.IO.Path]::GetRelativePath($staging, $file.FullName).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $name) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
    Invoke-BuildTool "$BuildTools\zipalign.exe" @('-f', '4', $unsigned, $aligned)

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
    Get-Item -LiteralPath (Join-Path $build 'DeepSeek-Local-Chat.apk')
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
