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

/// 云端配置校验：地址与 token 都可以留空（仅本地模式）；
/// 一旦填了就必须能真正连上，避免「看着配好了其实连不上」。
pub fn validate_cloud_config(server_url: &str, token: &str) -> Result<(String, String), String> {
    let server_url = server_url.trim().to_string();
    let token = token.trim().to_string();
    if !server_url.is_empty()
        && !server_url.starts_with("http://")
        && !server_url.starts_with("https://")
    {
        return Err("云端地址必须以 http:// 或 https:// 开头".to_string());
    }
    if !token.is_empty() && token.len() < 20 {
        return Err("token 不完整：请从打印中心重新复制，或留空以仅本地使用".to_string());
    }
    if !server_url.is_empty() && token.is_empty() {
        return Err("已填云端地址但缺少 token；如需仅本地使用，请把地址也留空".to_string());
    }
    Ok((server_url, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(server_url: &str, token: &str) -> AgentConfig {
        AgentConfig {
            server_url: server_url.to_string(),
            token: token.to_string(),
            ..AgentConfig::default()
        }
    }

    #[test]
    fn ws_url_maps_http_schemes_and_trims_trailing_slash() {
        assert_eq!(
            agent("https://api.example.com/", "token")
                .ws_url()
                .as_deref(),
            Some("wss://api.example.com/api/print/agent/ws?token=token")
        );
        assert_eq!(
            agent("http://localhost:3000", "token").ws_url().as_deref(),
            Some("ws://localhost:3000/api/print/agent/ws?token=token")
        );
    }

    #[test]
    fn ws_url_requires_server_url_and_token() {
        assert_eq!(agent("", "token").ws_url(), None);
        assert_eq!(agent("https://api.example.com", "   ").ws_url(), None);
    }

    #[test]
    fn config_round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = config_path(dir.path());
        let mut original = agent("https://api.example.com", "token");
        original.agent_name = "一号机".to_string();
        original.printers.push(PrinterProfileConfig {
            name: "Zebra ZD421".to_string(),
            kind: "THERMAL".to_string(),
            connection: "RAW_TCP".to_string(),
            address: Some("192.168.1.20:9100".to_string()),
            format: "ZPL".to_string(),
            calibration: Calibration::default(),
        });
        original.save(&path).expect("save");

        let loaded = AgentConfig::load(&path);
        assert_eq!(loaded.agent_name, "一号机");
        assert_eq!(loaded.printers.len(), 1);
        assert_eq!(
            loaded.printers[0].address.as_deref(),
            Some("192.168.1.20:9100")
        );
        assert_eq!(loaded.printers[0].calibration.density, 8);
    }

    #[test]
    fn missing_config_falls_back_to_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let loaded = AgentConfig::load(&config_path(dir.path()));
        assert!(loaded.server_url.is_empty());
        assert!(loaded.printers.is_empty());
    }

    #[test]
    fn empty_cloud_config_means_local_mode() {
        assert_eq!(
            validate_cloud_config("", ""),
            Ok(("".to_string(), "".to_string()))
        );
        assert_eq!(
            validate_cloud_config("  ", "  "),
            Ok(("".to_string(), "".to_string()))
        );
    }

    #[test]
    fn filled_cloud_config_must_be_complete() {
        assert!(validate_cloud_config("https://api.weaveorder.cn", "").is_err());
        assert!(validate_cloud_config("https://api.weaveorder.cn", "short").is_err());
        assert!(validate_cloud_config("api.weaveorder.cn", "x".repeat(32).as_str()).is_err());
        assert_eq!(
            validate_cloud_config(" https://api.weaveorder.cn ", " token-token-token-token "),
            Ok((
                "https://api.weaveorder.cn".to_string(),
                "token-token-token-token".to_string()
            ))
        );
    }
}
