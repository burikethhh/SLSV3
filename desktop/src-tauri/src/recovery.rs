//! Explicit one-time legacy recovery. Source is read-only; SQLite's backup
//! API includes committed WAL records. Never import authentication settings.
use crate::{db, license_verify};
use rusqlite::{params, Connection, DatabaseName, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

fn validate_owner(source: &Connection, gym: &str, public_key: &str) -> Result<(), String> {
    let mut statement = source
        .prepare("SELECT token FROM license_cache")
        .map_err(|_| "Legacy ownership credential missing")?;
    let tokens = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "Cannot read legacy ownership credential")?;
    let mut seen = false;
    for token in tokens {
        let claims = license_verify::verify_token(
            &token.map_err(|_| "Cannot read legacy credential")?,
            public_key,
        )
        .map_err(|_| "Legacy signature is invalid; manual recovery review required")?;
        if claims.gym_id.to_string() != gym {
            return Err("Legacy data belongs to another facility; recovery refused".into());
        }
        seen = true;
    }
    if !seen {
        return Err("No signed legacy facility identity; manual recovery review required".into());
    }
    Ok(())
}

pub fn recover(gym: &str) -> Result<Value, String> {
    let source_path = db::data_dir().join("sls_local.sqlite");
    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Cannot open the legacy database read-only")?;
    validate_owner(&source, gym, license_verify::EMBEDDED_PUBLIC_KEY_PEM)?;
    let mut target = db::conn()
        .lock()
        .map_err(|_| "Facility database unavailable")?;
    let selected: String = target
        .query_row("SELECT value FROM settings WHERE key='gym_id'", [], |r| {
            r.get(0)
        })
        .map_err(|_| "Connect a facility before recovery")?;
    if selected != gym {
        return Err("Facility changed; recovery refused".into());
    }
    if target
        .query_row(
            "SELECT value FROM settings WHERE key='legacy_import_v1'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Cannot check recovery receipt")?
        .is_some()
    {
        return Ok(json!({ "already_imported": true }));
    }
    let folder = db::data_dir()
        .join("recovery")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).map_err(|_| "Cannot create private recovery backup folder")?;
    let legacy_backup = folder.join("legacy.sqlite");
    source
        .backup(DatabaseName::Main, &legacy_backup, None)
        .map_err(|_| "Legacy backup failed; nothing imported")?;
    target
        .backup(
            DatabaseName::Main,
            folder.join("facility-before.sqlite"),
            None,
        )
        .map_err(|_| "Facility backup failed; nothing imported")?;
    let counts = merge_snapshot(&mut target, &legacy_backup)?;
    Ok(
        json!({ "already_imported": false, "counts": counts, "backup_folder": folder.to_string_lossy() }),
    )
}

fn merge_snapshot(target: &mut Connection, source: &Path) -> Result<Value, String> {
    target
        .execute(
            "ATTACH DATABASE ?1 AS legacy_recovery",
            params![source.to_string_lossy()],
        )
        .map_err(|_| "Cannot open recovery snapshot")?;
    let result = (|| {
        let tx = target
            .transaction()
            .map_err(|_| "Cannot start recovery transaction")?;
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sales) OR EXISTS(SELECT 1 FROM outbox)",
                [],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|_| "Cannot inspect destination")?
        {
            return Err("Destination already contains local transactions; reconcile them before legacy recovery".into());
        }
        // Cloud lifecycle wins; fill only missing local face vectors. Do not
        // resurrect a deleted/expired member with a stale legacy lifecycle.
        let members = tx.execute("INSERT INTO members(id,full_name,embedding_dim,face_vector,status,expires_at)
            SELECT id,full_name,embedding_dim,face_vector,status,expires_at FROM legacy_recovery.members WHERE true
            ON CONFLICT(id) DO UPDATE SET face_vector=coalesce(members.face_vector,excluded.face_vector),
            embedding_dim=CASE WHEN members.face_vector IS NULL THEN excluded.embedding_dim ELSE members.embedding_dim END", [])
            .map_err(|_| "Member recovery failed; nothing imported")?;
        let pending_sales: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM legacy_recovery.outbox WHERE op='sale')",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot inspect legacy pending sales")?;
        let products = tx.execute(if pending_sales {
            "INSERT INTO products SELECT id,name,price_cents,stock FROM legacy_recovery.products WHERE true
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,price_cents=excluded.price_cents,stock=excluded.stock"
        } else {
            "INSERT OR IGNORE INTO products SELECT id,name,price_cents,stock FROM legacy_recovery.products"
        }, []).map_err(|_| "Product recovery failed; nothing imported")?;
        let attendance = tx.execute("INSERT OR IGNORE INTO attendance_logs SELECT id,member_id,direction,confidence,created_at FROM legacy_recovery.attendance_logs", [])
            .map_err(|_| "Attendance recovery failed; nothing imported")?;
        let sales = tx.execute("INSERT INTO sales SELECT id,items_json,total_cents,pay_method,created_at FROM legacy_recovery.sales", [])
            .map_err(|_| "Sale recovery failed; nothing imported")?;
        let pending = tx.execute("INSERT INTO outbox SELECT id,op,payload,attempts,created_at FROM legacy_recovery.outbox", [])
            .map_err(|_| "Pending-record recovery failed; nothing imported")?;
        tx.execute(
            "INSERT INTO settings(key,value) VALUES('legacy_import_v1',?1)",
            params![chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|_| "Cannot write recovery receipt")?;
        tx.commit().map_err(|_| "Recovery not committed")?;
        Ok(
            json!({ "members": members, "products": products, "attendance": attendance, "sales": sales, "pending": pending }),
        )
    })();
    let _ = target.execute("DETACH DATABASE legacy_recovery", []);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_preserves_ids_attempts_and_rolls_back_conflicts() {
        let folder =
            std::env::temp_dir().join(format!("sls-recovery-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let source_path = folder.join("legacy.sqlite");
        let source = db::open_db(source_path.clone()).unwrap();
        source.execute_batch("INSERT INTO members(id,full_name,face_vector) VALUES('member','Legacy face','[1,2]');
            INSERT INTO sales VALUES('sale','[]',100,'cash','2020-01-01');
            INSERT INTO outbox VALUES('sale','sale','{}',10,'2020-01-01');
            INSERT INTO products VALUES('product','Water',100,3);").unwrap();
        let mut target = db::open_db(folder.join("target.sqlite")).unwrap();
        target.execute("INSERT INTO members(id,full_name,status) VALUES('member','Cloud name','cancelled')",[]).unwrap();
        let result = merge_snapshot(&mut target, &source_path).unwrap();
        assert_eq!(result["pending"], 1);
        assert_eq!(
            target
                .query_row("SELECT attempts FROM outbox", [], |r| r.get::<_, i32>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            target
                .query_row("SELECT status FROM members", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "cancelled"
        );
        assert_eq!(
            target
                .query_row("SELECT face_vector FROM members", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "[1,2]"
        );
        assert!(merge_snapshot(&mut target, &source_path).is_err());
        assert_eq!(
            source
                .query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, i32>(0))
                .unwrap(),
            1
        );
        let mut conflict = db::open_db(folder.join("conflict.sqlite")).unwrap();
        conflict
            .execute("INSERT INTO outbox VALUES('new','sale','{}',0,'now')", [])
            .unwrap();
        assert!(merge_snapshot(&mut conflict, &source_path).is_err());
        assert_eq!(
            conflict
                .query_row("SELECT count(*) FROM members", [], |r| r.get::<_, i32>(0))
                .unwrap(),
            0
        );
        assert!(
            validate_owner(&source, "unknown", license_verify::EMBEDDED_PUBLIC_KEY_PEM).is_err()
        );
        // Test databases are retained in the OS temp folder, never user data.
    }
}
