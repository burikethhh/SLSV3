use base64::Engine;
use minisign_verify::{PublicKey, Signature};
fn decode(text: String) -> Result<String, Box<dyn std::error::Error>> {
    if text.starts_with("untrusted comment:") {
        return Ok(text);
    }
    Ok(String::from_utf8(
        base64::engine::general_purpose::STANDARD.decode(text.trim())?,
    )?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("Usage: verifier installer.exe installer.exe.sig updater-public.key".into());
    }
    let mut bytes = std::fs::read(&args[1])?;
    let signature = Signature::decode(&decode(std::fs::read_to_string(&args[2])?)?)?;
    let key = PublicKey::decode(&decode(std::fs::read_to_string(&args[3])?)?)?;
    key.verify(&bytes, &signature, false)?;
    if let Some(last) = bytes.last_mut() {
        *last ^= 1;
    }
    if key.verify(&bytes, &signature, false).is_ok() {
        return Err("Tamper rejection failed".into());
    }
    println!("PASS updater signature matches existing fleet key; modified installer rejected");
    Ok(())
}
