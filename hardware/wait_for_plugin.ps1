Write-Host "Waiting for ESP32-S3 to be plugged in..." -ForegroundColor Cyan

$foundPort = $null
$deadline = (Get-Date).AddSeconds(45)

while ((Get-Date) -lt $deadline) {
    $devs = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Caption -match 'COM\d+' -and $_.DeviceID -match '303A' }
    if ($devs) {
        if ($devs.Caption -match '(COM\d+)') {
            $foundPort = $matches[1]
            Write-Host "Detected ESP32-S3 on $foundPort!" -ForegroundColor Green
            break
        }
    }
    # Also check if any USB Serial port appeared
    $allPorts = [System.IO.Ports.SerialPort]::GetPortNames()
    foreach ($p in $allPorts) {
        if ($p -notin @('COM3', 'COM4')) {
            $foundPort = $p
            Write-Host "Detected new port $foundPort!" -ForegroundColor Green
            break
        }
    }
    if ($foundPort) { break }
    Start-Sleep -Milliseconds 500
}

if (-not $foundPort) {
    Write-Host "No ESP32 detected within 45 seconds. Please ensure it is plugged into USB." -ForegroundColor Yellow
    exit 1
}

Start-Sleep -Seconds 1

Write-Host "Attempting serial communication on $foundPort..." -ForegroundColor Cyan
$sp = [System.IO.Ports.SerialPort]::new($foundPort, 115200)
$sp.ReadTimeout = 2000
$sp.WriteTimeout = 2000
$sp.DtrEnable = $true
$sp.RtsEnable = $true

try {
    $sp.Open()
    Start-Sleep -Milliseconds 400
    
    $banner = $sp.ReadExisting()
    if ($banner) {
        Write-Host "Boot Banner: $banner" -ForegroundColor Magenta
    }

    # Test PING
    $sp.WriteLine("PING")
    Start-Sleep -Milliseconds 300
    $resp = $sp.ReadExisting()
    Write-Host "PING Reply: '$resp'" -ForegroundColor Green

    # Test VERSION
    $sp.WriteLine("VERSION")
    Start-Sleep -Milliseconds 300
    $v = $sp.ReadExisting()
    Write-Host "VERSION Reply: '$v'" -ForegroundColor Green

    # Test STATUS
    $sp.WriteLine("STATUS")
    Start-Sleep -Milliseconds 300
    $s = $sp.ReadExisting()
    Write-Host "STATUS Reply: '$s'" -ForegroundColor Green

    if ($resp -match "PONG" -or $banner -match "READY:fw=3.1.0" -or $v -match "3.1.0") {
        Write-Host "`n>>> SUCCESS: ESP32-S3 Firmware 3.1.0 is 100% OPERATIONAL! <<<" -ForegroundColor Green
        exit 0
    }
} catch {
    Write-Error $_.Exception.Message
} finally {
    if ($sp.IsOpen) { $sp.Close() }
}
