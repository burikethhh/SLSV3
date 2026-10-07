# Test SLS gate serial communication
param(
    [string]$Port = ""
)

$ports = if ($Port) { @($Port) } else { @("COM7", "COM6") }

foreach ($p in $ports) {
    Write-Host "Testing $p..." -NoNewline
    try {
        $sp = [System.IO.Ports.SerialPort]::new($p, 115200)
        $sp.ReadTimeout = 1500
        $sp.WriteTimeout = 1500
        $sp.DtrEnable = $true
        $sp.RtsEnable = $true
        $sp.Open()
        Start-Sleep -Milliseconds 300

        # Send PING
        $sp.WriteLine("PING")
        Start-Sleep -Milliseconds 200
        $resp = $sp.ReadExisting().Trim()

        if ($resp -match "ACK:PONG" -or $resp -match "READY:fw=") {
            Write-Host " CONNECTED!" -ForegroundColor Green
            Write-Host "Response: $resp" -ForegroundColor Cyan

            # Check VERSION
            $sp.WriteLine("VERSION")
            Start-Sleep -Milliseconds 200
            $v = $sp.ReadExisting().Trim()
            Write-Host "Version: $v" -ForegroundColor Cyan

            $sp.Close()
            exit 0
        } else {
            Write-Host " Opened, but response was: '$resp'" -ForegroundColor Yellow
        }
        $sp.Close()
    } catch {
        Write-Host " Failed ($($_.Exception.Message))" -ForegroundColor Gray
    }
}

Write-Host "Could not get ACK:PONG on tested ports. Tap the RESET button (or replug USB) on your ESP32-S3 and try again." -ForegroundColor Yellow
exit 1
