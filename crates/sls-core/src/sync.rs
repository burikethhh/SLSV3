//! Offline-first outbox. Local SQLite is the source of truth at the gate;
//! rows land here first, then a background worker pushes to Supabase
//! (PostgREST) and applies pulls (catalog/plans/revoked licenses).
//! Mirrors `supabase/migrations/0001_init.sql` table names.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Attendance,
    MemberUpsert,
    Sale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxRow {
    pub id: Uuid,
    pub op: Op,
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
    /// Exponential backoff attempts: 5s → 15s → 30s → 60s → drop to DLQ log.
    pub attempts: u32,
}

impl OutboxRow {
    pub fn new(op: Op, payload: serde_json::Value) -> Self {
        Self { id: Uuid::new_v4(), op, payload, created_at: Utc::now(), attempts: 0 }
    }
    pub fn backoff_secs(attempts: u32) -> u64 {
        match attempts {
            0 => 5,
            1 => 15,
            2 => 30,
            _ => 60,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backoff_matches_desktop_worker() {
        assert_eq!(OutboxRow::backoff_secs(0), 5);
        assert_eq!(OutboxRow::backoff_secs(1), 15);
        assert_eq!(OutboxRow::backoff_secs(2), 30);
        assert_eq!(OutboxRow::backoff_secs(3), 60);
        assert_eq!(OutboxRow::backoff_secs(99), 60);
    }
    #[test]
    fn outbox_row_shapes() {
        let r = OutboxRow::new(Op::Attendance, serde_json::json!({"member_id":"m1","confidence":0.9}));
        assert_eq!(r.attempts, 0);
        assert!(serde_json::to_string(&r).unwrap().contains("attendance"));
    }
}
