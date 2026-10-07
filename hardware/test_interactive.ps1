$p = [System.IO.Ports.SerialPort]::new("COM7", 115200)
$p.ReadTimeout = 2000
$p.WriteTimeout = 2000
$p.DtrEnable = $false
$p.RtsEnable = $false

try {
    $p.Open()
    Start-Sleep -Seconds 1
    
    $initial = $p.ReadExisting()
    Write-Host "Initial text on COM7: '$initial'"

    $p.WriteLine("PING")
    Start-Sleep -Milliseconds 500
    
    $reply = $p.ReadExisting()
    Write-Host "Reply to PING: '$reply'"
} catch {
    Write-Error $_.Exception.Message
} finally {
    if ($p.IsOpen) { $p.Close() }
}
