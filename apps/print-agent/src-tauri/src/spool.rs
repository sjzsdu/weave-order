use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 服务端下发的任务（只保留打印所需字段）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolJob {
    pub id: String,
    pub format: String,
    pub copies: i64,
    pub payload: String,
    #[serde(default)]
    pub printer_id: Option<String>,
    #[serde(default)]
    pub printer_name: Option<String>,
    #[serde(default)]
    pub printer_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolStatus {
    pub pending: i64,
    pub failed: i64,
    pub printed: i64,
}

pub struct Spool {
    conn: Mutex<Connection>,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

impl Spool {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).context("打开本地 spool 失败")?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              format TEXT NOT NULL,
              copies INTEGER NOT NULL,
              payload TEXT NOT NULL,
              printer_id TEXT,
              printer_name TEXT,
              printer_kind TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              error TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
            "#,
        )?;
        let spool = Self {
            conn: Mutex::new(conn),
        };
        spool.cleanup_expired()?;
        Ok(spool)
    }

    /// 幂等：同一 id 重复入队直接忽略，防止重连后补传重打。
    pub fn enqueue(&self, job: &SpoolJob) -> Result<bool> {
        let conn = self.conn.lock().expect("spool poisoned");
        let now = now_seconds();
        let changed = conn.execute(
            r#"INSERT OR IGNORE INTO jobs
               (id, format, copies, payload, printer_id, printer_name, printer_kind, status, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)"#,
            params![
                job.id,
                job.format,
                job.copies,
                job.payload,
                job.printer_id,
                job.printer_name,
                job.printer_kind,
                now
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn next_pending(&self) -> Result<Option<SpoolJob>> {
        let conn = self.conn.lock().expect("spool poisoned");
        let job = conn
            .query_row(
                r#"SELECT id, format, copies, payload, printer_id, printer_name, printer_kind
                   FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"#,
                [],
                |row| {
                    Ok(SpoolJob {
                        id: row.get(0)?,
                        format: row.get(1)?,
                        copies: row.get(2)?,
                        payload: row.get(3)?,
                        printer_id: row.get(4)?,
                        printer_name: row.get(5)?,
                        printer_kind: row.get(6)?,
                    })
                },
            )
            .optional()?;
        Ok(job)
    }

    pub fn mark_printed(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().expect("spool poisoned");
        conn.execute(
            "UPDATE jobs SET status = 'printed', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1",
            params![id, now_seconds()],
        )?;
        Ok(())
    }

    pub fn mark_failed(&self, id: &str, error: &str) -> Result<()> {
        let conn = self.conn.lock().expect("spool poisoned");
        conn.execute(
            "UPDATE jobs SET status = 'failed', attempts = attempts + 1, error = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, error, now_seconds()],
        )?;
        Ok(())
    }

    pub fn unreported(&self) -> Result<Vec<(String, String, Option<String>)>> {
        let conn = self.conn.lock().expect("spool poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, status, error FROM jobs WHERE status IN ('printed','failed') AND attempts < 20 ORDER BY updated_at ASC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    pub fn mark_reported(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().expect("spool poisoned");
        conn.execute(
            "UPDATE jobs SET status = 'reported', updated_at = ?2 WHERE id = ?1",
            params![id, now_seconds()],
        )?;
        Ok(())
    }

    pub fn cleanup_expired(&self) -> Result<()> {
        let conn = self.conn.lock().expect("spool poisoned");
        let cutoff = now_seconds() - 24 * 3600;
        conn.execute(
            "DELETE FROM jobs WHERE created_at < ?1 AND status IN ('reported','failed')",
            params![cutoff],
        )?;
        // 未上报的旧载荷也不应该无限保留：超过 24h 强制清理。
        conn.execute("DELETE FROM jobs WHERE created_at < ?1", params![cutoff])?;
        Ok(())
    }

    pub fn status(&self) -> Result<SpoolStatus> {
        let conn = self.conn.lock().expect("spool poisoned");
        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status IN ('pending','printed')",
            [],
            |row| row.get(0),
        )?;
        let failed: i64 =
            conn.query_row("SELECT COUNT(*) FROM jobs WHERE status = 'failed'", [], |row| {
                row.get(0)
            })?;
        let printed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'reported'",
            [],
            |row| row.get(0),
        )?;
        Ok(SpoolStatus {
            pending,
            failed,
            printed,
        })
    }

    pub fn clear(&self) -> Result<()> {
        let conn = self.conn.lock().expect("spool poisoned");
        conn.execute("DELETE FROM jobs", [])?;
        conn.execute("VACUUM", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str) -> SpoolJob {
        SpoolJob {
            id: id.to_string(),
            format: "ZPL".to_string(),
            copies: 1,
            payload: "^XA^XZ".to_string(),
            printer_id: None,
            printer_name: Some("Zebra".to_string()),
            printer_kind: Some("THERMAL".to_string()),
        }
    }

    #[test]
    fn enqueue_is_idempotent_per_task_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::open(&dir.path().join("spool.sqlite")).expect("open");
        assert!(spool.enqueue(&job("task-1")).expect("enqueue"));
        // 重连补传同一个任务不能重复出纸。
        assert!(!spool.enqueue(&job("task-1")).expect("enqueue"));
        assert_eq!(spool.status().expect("status").pending, 1);
    }

    #[test]
    fn next_pending_returns_jobs_in_creation_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::open(&dir.path().join("spool.sqlite")).expect("open");
        spool.enqueue(&job("task-1")).expect("enqueue");
        spool.enqueue(&job("task-2")).expect("enqueue");
        assert_eq!(
            spool.next_pending().expect("next").map(|job| job.id),
            Some("task-1".to_string())
        );
        spool.mark_printed("task-1").expect("printed");
        assert_eq!(
            spool.next_pending().expect("next").map(|job| job.id),
            Some("task-2".to_string())
        );
    }

    #[test]
    fn printed_and_failed_jobs_are_reported_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::open(&dir.path().join("spool.sqlite")).expect("open");
        spool.enqueue(&job("task-1")).expect("enqueue");
        spool.mark_printed("task-1").expect("printed");
        spool.mark_failed("task-1", "纸卷用完").expect("failed");

        let unreported = spool.unreported().expect("unreported");
        assert_eq!(unreported.len(), 1);
        assert_eq!(unreported[0].1, "failed");
        assert_eq!(unreported[0].2.as_deref(), Some("纸卷用完"));

        spool.mark_reported("task-1").expect("reported");
        assert!(spool.unreported().expect("unreported").is_empty());
        let status = spool.status().expect("status");
        assert_eq!((status.pending, status.failed, status.printed), (0, 0, 1));
    }

    #[test]
    fn clear_removes_every_job() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spool = Spool::open(&dir.path().join("spool.sqlite")).expect("open");
        spool.enqueue(&job("task-1")).expect("enqueue");
        spool.enqueue(&job("task-2")).expect("enqueue");
        spool.clear().expect("clear");
        assert_eq!(spool.status().expect("status").pending, 0);
        assert!(spool.next_pending().expect("next").is_none());
    }
}
