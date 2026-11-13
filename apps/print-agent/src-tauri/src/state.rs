use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, RwLock};

use crate::config::{config_path, AgentConfig};
use crate::spool::Spool;

#[derive(Clone)]
pub struct AppState {
    pub app: AppHandle,
    pub config_path: PathBuf,
    pub config: Arc<RwLock<AgentConfig>>,
    pub spool: Arc<Spool>,
    pub client: reqwest::Client,
    /// 配置变更：断开 WSS 重连。
    pub config_notify: Arc<Notify>,
    /// 新任务：唤醒本地执行器。
    pub jobs_notify: Arc<Notify>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        std::fs::create_dir_all(&dir).ok();
        let path = config_path(&dir);
        let config = AgentConfig::load(&path);
        let spool = Spool::open(&dir.join("spool.sqlite"))?;
        Ok(Self {
            app: app.clone(),
            config_path: path,
            config: Arc::new(RwLock::new(config)),
            spool: Arc::new(spool),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()?,
            config_notify: Arc::new(Notify::new()),
            jobs_notify: Arc::new(Notify::new()),
        })
    }

    pub async fn snapshot(&self) -> AgentConfig {
        self.config.read().await.clone()
    }

    pub fn emit_status(&self, status: &str, message: &str) {
        let _ = self.app.emit(
            "agent-status",
            serde_json::json!({ "status": status, "message": message }),
        );
        tracing::info!(status, message, "agent status");
    }

    pub fn emit_log(&self, message: &str) {
        let _ = self.app.emit(
            "agent-log",
            serde_json::json!({ "message": message }),
        );
    }
}
