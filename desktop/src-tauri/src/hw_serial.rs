//! Recycled from orig `desktop/src-tauri/src/hardware.rs` — slimmed for v3 single gate.
//! Kept: VID-scored ESP32 auto-detect, DTR-safe connect, PING best-effort,
//! 3x-retry `send_command` with auto-clear, `unlock_door` / `deny` / `grant_entry`.
//! Dropped: exit-lane + tailgate paths (`grant_exit`, ALERT_TAILGATE), LCD brand screen
//! (firmware v3 uses fixed idle text). Serial only builds with `hardware-serial`.
//!
//! Protocol (firmware `hardware/src/main.cpp`): `UNLOCK:<secs>`, `WELCOME:<name>|<secs>`,
//! `DENY[:reason]`, `BEEP`, `PING`→`ACK:PONG`. Baud 115200.

#[cfg(feature = "hardware-serial")]
pub use inner::*;

#[cfg(not(feature = "hardware-serial"))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct HardwareButtonEvent {
    pub kind: String,
    pub timestamp_ms: u64,
}

#[cfg(feature = "hardware-serial")]
mod inner {
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Debug, Clone, serde::Serialize)]
    pub struct HardwareButtonEvent {
        pub kind: String, // "entry_btn" or "exit_btn"
        pub timestamp_ms: u64,
    }

    #[derive(Clone)]
    pub struct HardwareManager {
        port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
        connected: Arc<Mutex<Option<String>>>,
        events: Arc<Mutex<Vec<HardwareButtonEvent>>>,
        reader_running: Arc<AtomicBool>,
    }

    impl HardwareManager {
        pub fn new() -> Self {
            Self {
                port: Arc::new(Mutex::new(None)),
                connected: Arc::new(Mutex::new(None)),
                events: Arc::new(Mutex::new(Vec::new())),
                reader_running: Arc::new(AtomicBool::new(false)),
            }
        }

        pub fn list_available_ports() -> Vec<String> {
            serialport::available_ports()
                .unwrap_or_default()
                .into_iter()
                .map(|p| match p.port_type {
                    serialport::SerialPortType::UsbPort(info) => {
                        format!("{} (USB: {:04x}:{:04x})", p.port_name, info.vid, info.pid)
                    }
                    _ => p.port_name,
                })
                .collect()
        }

        /// VID whitelist: FTDI, CP210x, CH34x, Espressif native USB.
        const AUTO_CONNECT_VIDS: [u16; 4] = [0x0403, 0x10C4, 0x1A86, 0x303A];

        pub fn find_esp_ports(&self) -> Vec<String> {
            let mut scored: Vec<(u8, String)> = Vec::new();
            for p in serialport::available_ports().unwrap_or_default() {
                if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                    if !Self::AUTO_CONNECT_VIDS.contains(&info.vid) {
                        continue;
                    }
                    let mut score: u8 = 1;
                    if info.vid == 0x0403 && info.pid == 0x6001 {
                        score = 4;
                    } else if info.vid == 0x10C4 {
                        score = 3;
                    }
                    scored.push((score, p.port_name));
                }
            }
            scored.sort_by(|a, b| b.0.cmp(&a.0));
            scored.into_iter().map(|(_, n)| n).collect()
        }

        pub fn connect(&self, port_name: &str, baud_rate: u32) -> Result<String, String> {
            if self.reader_running.load(Ordering::SeqCst) {
                self.reader_running.store(false, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(80));
            }
            use std::io::Write;
            let mut serial = serialport::new(port_name, baud_rate)
                .timeout(Duration::from_millis(500))
                .open()
                .map_err(|e| format!("Failed to open {port_name}: {e}"))?;
            // Field FTDI wires DTR→EN: asserted DTR holds ESP32 in reset.
            let _ = serial.write_data_terminal_ready(false);
            let _ = serial.write_request_to_send(false);
            // Best-effort PING (silence must NOT reject — C3 can boot silent).
            let _ = serial.write_all(b"PING\n").and_then(|_| serial.flush());

            let mut reader = serial.try_clone().map_err(|e| format!("clone failed: {e}"))?;
            reader.set_timeout(Duration::from_millis(200)).ok();
            *self.port.lock() = Some(serial);
            *self.connected.lock() = Some(port_name.to_string());
            self.start_reader(reader);
            Ok(format!("Connected to ESP32 on {port_name}"))
        }

        fn start_reader(&self, mut r: Box<dyn serialport::SerialPort>) {
            self.reader_running.store(true, Ordering::SeqCst);
            let events = self.events.clone();
            let running = self.reader_running.clone();
            std::thread::spawn(move || {
                let mut line = Vec::<u8>::with_capacity(64);
                let mut buf = [0u8; 64];
                while running.load(Ordering::SeqCst) {
                    match r.read(&mut buf) {
                        Ok(n) if n > 0 => {
                            for &b in &buf[..n] {
                                if b == b'\n' {
                                    let text = String::from_utf8_lossy(&line).trim().to_string();
                                    line.clear();
                                    if text == "EVT:EXIT_BTN" {
                                        let _context = crate::terminal_context().read();
                                        let _ = crate::db::log_exit_button();
                                        let mut q = events.lock();
                                        if q.len() < 16 {
                                            q.push(HardwareButtonEvent {
                                                kind: "exit_btn".into(),
                                                timestamp_ms: std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .map(|d| d.as_millis() as u64)
                                                    .unwrap_or(0),
                                            });
                                        }
                                    } else if text == "EVT:ENTRY_BTN" {
                                        let mut q = events.lock();
                                        if q.len() < 16 {
                                            q.push(HardwareButtonEvent {
                                                kind: "entry_btn".into(),
                                                timestamp_ms: std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .map(|d| d.as_millis() as u64)
                                                    .unwrap_or(0),
                                            });
                                        }
                                    }
                                } else if line.len() < 256 {
                                    line.push(b);
                                } else {
                                    line.clear();
                                }
                            }
                        }
                        _ => std::thread::sleep(Duration::from_millis(20)),
                    }
                }
            });
        }

        pub fn drain_button_events(&self) -> Vec<HardwareButtonEvent> {
            std::mem::take(&mut *self.events.lock())
        }

        /// 3x retry on transient USB write errors; auto-clear after final failure.
        pub fn send_command(&self, cmd: &str) -> Result<(), String> {
            use std::io::Write;
            let formatted = format!("{}\n", cmd.trim());
            let mut last_err = String::new();
            for attempt in 0..3 {
                let mut g = self.port.lock();
                match g.as_mut() {
                    Some(p) => match p.write_all(formatted.as_bytes()).and_then(|_| p.flush()) {
                        Ok(_) => return Ok(()),
                        Err(e) => {
                            last_err = format!("attempt {}: {e}", attempt + 1);
                            std::thread::sleep(Duration::from_millis(80));
                        }
                    },
                    None => return Err("No active hardware COM port connection".into()),
                }
            }
            *self.port.lock() = None;
            *self.connected.lock() = None;
            self.reader_running.store(false, Ordering::SeqCst);
            Err(format!("Hardware disconnected ({last_err}). Reconnecting."))
        }

        pub fn deny(&self, reason: &str) -> Result<String, String> {
            let clean: String = reason.chars().filter(|c| !matches!(c, '|' | ':' | '\n' | '\r')).take(16).collect();
            self.send_command(&format!("DENY:{clean}"))?;
            Ok(format!("Deny shown ({clean})"))
        }

        pub fn unlock_door(&self, duration_ms: u32) -> Result<String, String> {
            let secs = std::cmp::max(1, duration_ms / 1000);
            self.send_command(&format!("UNLOCK:{secs}"))?;
            Ok(format!("Unlock sent ({secs}s)"))
        }

        pub fn grant_entry(&self, member_name: &str, duration_ms: u32) -> Result<String, String> {
            let secs = std::cmp::max(1, duration_ms / 1000);
            let clean: String = member_name.chars().take(16).collect();
            self.send_command(&format!("WELCOME:{clean}|{secs}"))?;
            Ok(format!("Welcome sent for {clean} ({secs}s)"))
        }

        pub fn get_status(&self) -> (bool, Option<String>) {
            let n = self.connected.lock().clone();
            (n.is_some(), n)
        }
    }

    impl Default for HardwareManager {
        fn default() -> Self {
            Self::new()
        }
    }
}
