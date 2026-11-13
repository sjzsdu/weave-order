use tauri::State;

use crate::config::{PrinterProfileConfig, Calibration};
use crate::printer::test_print;
use crate::printers::{self, DiscoveredPrinter};
use crate::spool::SpoolStatus;
use crate::state::AppState;

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<crate::config::AgentConfig, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn save_config(
    state: State<'_, AppState>,
    server_url: String,
    token: String,
    agent_name: String,
) -> Result<(), String> {
    let server_url = server_url.trim().to_string();
    if !server_url.starts_with("http://") && !server_url.starts_with("https://") {
        return Err("云端地址必须以 http:// 或 https:// 开头".to_string());
    }
    if token.trim().len() < 20 {
        return Err("token 不合法：请在打印中心重新注册代理".to_string());
    }
    {
        let mut config = state.config.write().await;
        config.server_url = server_url;
        config.token = token.trim().to_string();
        config.agent_name = if agent_name.trim().is_empty() {
            "打印代理".to_string()
        } else {
            agent_name.trim().to_string()
        };
        config
            .save(&state.config_path)
            .map_err(|error| error.to_string())?;
    }
    state.config_notify.notify_waiters();
    Ok(())
}

#[tauri::command]
pub async fn discovered_printers(state: State<'_, AppState>) -> Result<Vec<DiscoveredPrinter>, String> {
    let configured = state.config.read().await.printers.clone();
    Ok(printers::merge(printers::discover(), &configured))
}

#[tauri::command]
pub async fn save_printers(
    state: State<'_, AppState>,
    printers: Vec<DiscoveredPrinter>,
) -> Result<(), String> {
    let profiles: Vec<PrinterProfileConfig> = printers
        .into_iter()
        .map(|printer| PrinterProfileConfig {
            name: printer.name,
            kind: printer.kind,
            connection: if printer.connection.is_empty() {
                "SYSTEM_DRIVER".to_string()
            } else {
                printer.connection
            },
            address: printer.address,
            format: if printer.format == "TSPL" {
                "TSPL".to_string()
            } else {
                "ZPL".to_string()
            },
            calibration: Calibration::default(),
        })
        .collect();
    {
        let mut config = state.config.write().await;
        config.printers = profiles;
        config
            .save(&state.config_path)
            .map_err(|error| error.to_string())?;
    }
    state.config_notify.notify_waiters();
    Ok(())
}

#[tauri::command]
pub async fn spool_status(state: State<'_, AppState>) -> Result<SpoolStatus, String> {
    state.spool.status().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn clear_local_data(state: State<'_, AppState>) -> Result<(), String> {
    state.spool.clear().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn test_print(state: State<'_, AppState>) -> Result<(), String> {
    let profile = state
        .config
        .read()
        .await
        .printers
        .first()
        .cloned()
        .ok_or_else(|| "还没有保存打印机 profile".to_string())?;
    test_print(&profile).map_err(|error| error.to_string())
}
