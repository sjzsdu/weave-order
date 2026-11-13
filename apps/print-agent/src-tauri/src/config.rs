use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 本地校准：不改云端模板，只叠加到发往这台打印机的指令里。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    #[serde(default)]
    pub x_offset: i32,
    #[serde(default)]
    pub y_offset: i32,
    #[serde(default = "default_density")]
    pub density: i32,
}

fn default_density() -> i32 {
    8
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            x_offset: 0,
            y_offset: 0,
            density: default_density(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterProfileConfig {
    pub name: String,
    /// A4 / THERMAL / BLUETOOTH（与后端枚举一致）。
    pub kind: String,
    /// SYSTEM_DRIVER / RAW_TCP / USB / BLUETOOTH。
    pub connection: String,
    pub address: Option<String>,
    /// ZPL / TSPL；A4 忽略。
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default)]
    pub calibration: Calibration,
}

fn default_format() -> String {
    "ZPL".to_string()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub server_url: String,
    pub token: String,
    pub agent_name: String,
    #[serde(default)]
    pub printers: Vec<PrinterProfileConfig>,
}

impl AgentConfig {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<AgentConfig>(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn api_base(&self) -> String {
        self.server_url.trim_end_matches('/').to_string()
    }

    pub fn ws_url(&self) -> Option<String> {
        if self.server_url.trim().is_empty() || self.token.trim().is_empty() {
            return None;
        }
        let base = self
            .api_base()
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        // JWT 只含 base64url + '.'，无需额外 URL 编码。
        Some(format!("{base}/api/print/agent/ws?token={}", self.token))
    }
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("agent-config.json")
}
