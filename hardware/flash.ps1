# SLS v3 ESP32-S3 Firmware Flasher
param(
    [string]$Port = "COM6",
    [int]$TimeoutSeconds = 60
)

$cli = "C:\Users\ketha\.gemini\antigravity-ide\brain\da43882e-eb0f-4e9b-a34f-918b9b38cdab\scratch\arduino-cli\arduino-cli.exe"
$sketch = "C:\Users\ketha\.gemini\antigravity-ide\brain\da43882e-eb0f-4e9b-a34f-918b9b38cdab\scratch\sls_gate"
$fqbn = "esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,USBMode=hwcdc"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " SLS v3 ESP32-S3-N16R8 Flasher (Port: $Port)      " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$startTime = [DateTime]::UtcNow
$attempt = 1

while (([DateTime]::UtcNow - $startTime).TotalSeconds -lt $TimeoutSeconds) {
    Write-Host "[Attempt $attempt] Connecting to $Port..." -NoNewline
    $res = & $cli upload -p $Port --fqbn $fqbn $sketch 2>&1 | Out-String

    if ($LASTEXITCODE -eq 0) {
        Write-Host " SUCCESS!" -ForegroundColor Green
        Write-Host $res
        Write-Host "`n>>> Firmware 3.1.0 successfully uploaded to ESP32-S3! <<<" -ForegroundColor Green
        exit 0
    }

    if ($res -match "Invalid head of packet" -or $res -match "Failed to connect") {
        Write-Host " Waiting for Bootloader mode..." -ForegroundColor Yellow
        Write-Host ">>> Hold BOOT (GPIO0), press & release RESET, then release BOOT <<<" -ForegroundColor Magenta
    } else {
        Write-Host " Retrying..." -ForegroundColor Gray
    }

    Start-Sleep -Seconds 2
    $attempt++
}

Write-Error "Flashing timed out after $TimeoutSeconds seconds. Ensure the ESP32 is plugged in and placed in bootloader mode."
exit 1
