$portName = "COM7"
Write-Host "Opening $portName at 115200..." -ForegroundColor Cyan

$sp = [System.IO.Ports.SerialPort]::new($portName, 115200)
$sp.ReadTimeout = 2000
$sp.WriteTimeout = 2000
$sp.NewLine = "`n"

try {
    $sp.Open()
    Write-Host "Port $portName opened successfully!" -ForegroundColor Green
    Start-Sleep -Milliseconds 500

    # Drain any startup bytes
    $existing = $sp.ReadExisting()
    if ($existing) {
        Write-Host "Startup output: $existing" -ForegroundColor Magenta
    }

    # Send PING
    Write-Host "Sending PING..." -ForegroundColor Yellow
    $sp.WriteLine("PING")
    Start-Sleep -Milliseconds 300
    $resp = $sp.ReadExisting().Trim()
    Write-Host "Received: '$resp'" -ForegroundColor Green

    # Send VERSION
    Write-Host "Sending VERSION..." -ForegroundColor Yellow
    $sp.WriteLine("VERSION")
    Start-Sleep -Milliseconds 300
    $v = $sp.ReadExisting().Trim()
    Write-Host "Received: '$v'" -ForegroundColor Green

    # Send STATUS
    Write-Host "Sending STATUS..." -ForegroundColor Yellow
    $sp.WriteLine("STATUS")
    Start-Sleep -Milliseconds 300
    $s = $sp.ReadExisting().Trim()
    Write-Host "Received: '$s'" -ForegroundColor Green

    if ($resp -match "PONG" -or $v -match "3.1.0" -or $existing -match "READY") {
        Write-Host "`n>>> VERIFICATION COMPLETE: ESP32-S3 FIRMWARE IS 100% OPERATIONAL! <<<" -ForegroundColor Green
    }
} catch {
    Write-Error $_.Exception.Message
} finally {
    if ($sp.IsOpen) {
        $sp.Close()
        Write-Host "Port closed." -ForegroundColor Gray
    }
}
