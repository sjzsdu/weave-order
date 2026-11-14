use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
    /// 上一次状态（状态 + 文案），用于抑制离线重连时的重复日志。
    last_status: Arc<Mutex<(String, String)>>,
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
            last_status: Arc::new(Mutex::new((String::new(), String::new()))),
        })
    }

    pub async fn snapshot(&self) -> AgentConfig {
        self.config.read().await.clone()
    }

    /// 状态没变就不重复发事件 / 写日志：离线重连时每 5 秒一条会把日志刷满。
    pub fn emit_status(&self, status: &str, message: &str) {
        {
            let mut last = self
                .last_status
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if last.0 == status && last.1 == message {
                return;
            }
            *last = (status.to_string(), message.to_string());
        }
        let _ = self.app.emit(
            "agent-status",
            serde_json::json!({ "status": status, "message": message }),
        );
        tracing::info!(status, message, "agent status");
    }

    pub fn emit_log(&self, message: &str) {
        let _ = self
            .app
            .emit("agent-log", serde_json::json!({ "message": message }));
    }
}
