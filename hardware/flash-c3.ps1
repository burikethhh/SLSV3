# SLS v3 ESP32-C3-N16R8 Firmware Flasher (mirrors flash.ps1 for the S3).
# Sketch source of truth: hardware/src/main.cpp, mirrored to
# hardware/sls_gate/sls_gate.ino (arduino-cli requires sketchdir/sketch.ino).
param(
    [string]$Port = "",
    [int]$TimeoutSeconds = 90
)

$cli = "C:\Users\ketha\.gemini\antigravity-ide\brain\da43882e-eb0f-4e9b-a34f-918b9b38cdab\scratch\arduino-cli\arduino-cli.exe"
$sketch = "B:\Projects\SoloLeveling\hardware\sls_gate"
$fqbn = "esp32:esp32:esp32c3:CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB"

if (-not $Port) {
    $esp = Get-CimInstance Win32_SerialPort | Where-Object { $_.PNPDeviceID -match "VID_303A" } | Select-Object -First 1
    if (-not $esp) { Write-Error "No Espressif USB device found. Plug in the C3 board (data cable!) and retry."; exit 1 }
    $Port = $esp.DeviceID
}

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " SLS v3 ESP32-C3-N16R8 Flasher (Port: $Port)      " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$startTime = [DateTime]::UtcNow
$attempt = 1

while (([DateTime]::UtcNow - $startTime).TotalSeconds -lt $TimeoutSeconds) {
    Write-Host "[Attempt $attempt] Connecting to $Port..." -NoNewline
    $res = & $cli upload -p $Port --fqbn $fqbn $sketch 2>&1 | Out-String

    if ($LASTEXITCODE -eq 0) {
        Write-Host " SUCCESS!" -ForegroundColor Green
        Write-Host $res
        Write-Host "`n>>> Firmware 3.1.0 successfully uploaded to ESP32-C3! <<<" -ForegroundColor Green
        exit 0
    }

    if ($res -match "Wrong --chip argument") {
        $chip = "unknown"
        if ($res -match "This chip is ([A-Za-z0-9-]+)") { $chip = $Matches[1] }
        Write-Error "That port is NOT a C3 (chip: $chip). Unplug other ESP32 boards or pass -Port explicitly."
        exit 1
    }

    if ($res -match "Invalid head of packet" -or $res -match "Failed to connect") {
        Write-Host " Waiting for Bootloader mode..." -ForegroundColor Yellow
        Write-Host ">>> Hold BOOT, press & release RESET/EN, then release BOOT <<<" -ForegroundColor Magenta
    } else {
        Write-Host " Retrying..." -ForegroundColor Gray
    }

    Start-Sleep -Seconds 2
    $attempt++
}

Write-Error "Flashing timed out after $TimeoutSeconds seconds. Ensure the ESP32-C3 is plugged in and placed in bootloader mode."
exit 1
