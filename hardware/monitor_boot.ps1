for ($i = 1; $i -le 20; $i++) {
    & powershell -ExecutionPolicy Bypass -File "b:\Projects\SoloLeveling\hardware\test_gate.ps1"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n>>> ESP32-S3 IS LIVE AND VERIFIED! <<<" -ForegroundColor Green
        exit 0
    }
    Start-Sleep -Seconds 2
}
exit 1
