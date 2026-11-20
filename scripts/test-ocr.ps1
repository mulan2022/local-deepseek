param([Parameter(Mandatory)] [string] $Jdk)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path ([IO.Path]::GetTempPath()) ('ocr-buffer-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $sources = @("$root/android/src/local/deepseek/chat/OcrFrameBuffer.java", "$root/android/src/local/deepseek/chat/OcrTextGate.java", "$PSScriptRoot/tests/OcrFrameBufferTest.java", "$PSScriptRoot/tests/OcrTextGateTest.java")
    & "$Jdk/bin/javac.exe" --release 8 -encoding UTF-8 -d $stage @sources
    if ($LASTEXITCODE -ne 0) { throw 'OCR test compilation failed' }
    & "$Jdk/bin/java.exe" -cp $stage local.deepseek.chat.OcrFrameBufferTest
    if ($LASTEXITCODE -ne 0) { throw 'OCR tests failed' }
    & "$Jdk/bin/java.exe" -cp $stage local.deepseek.chat.OcrTextGateTest
    if ($LASTEXITCODE -ne 0) { throw 'OCR text gate tests failed' }
} finally {
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path $resolved -Leaf) -match '^ocr-buffer-test-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
