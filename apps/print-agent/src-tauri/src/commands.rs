use tauri::State;

use crate::config::{validate_cloud_config, Calibration, PrinterProfileConfig};
use crate::printers::{self, DiscoveryReport, ProbeResult};
use crate::spool::SpoolStatus;
use crate::state::AppState;

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<crate::config::AgentConfig, String> {
    Ok(state.snapshot().await)
}

/// 保存云端配置。地址 / token 都可以留空：留空即「仅本地使用」，
/// 打印机发现与测试打印不依赖云端。
#[tauri::command]
pub async fn save_config(
    state: State<'_, AppState>,
    server_url: String,
    token: String,
    agent_name: String,
) -> Result<(), String> {
    let (server_url, token) = validate_cloud_config(&server_url, &token)?;
    {
        let mut config = state.config.write().await;
        config.server_url = server_url;
        config.token = token;
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

/// 发现本机打印队列，并把已保存的网络打印机合并进来，附带失败原因与修复建议。
/// 发现要起子进程 / 查系统队列，属于阻塞 I/O，放到 blocking 线程池，别占 async worker。
#[tauri::command]
pub async fn discovered_printers(state: State<'_, AppState>) -> Result<DiscoveryReport, String> {
    let configured = state.config.read().await.printers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = printers::discover();
        report.printers = printers::merge(report.printers, &configured);
        report
    })
    .await
    .map_err(|error| error.to_string())
}

/// 本地检测：TCP 可达性或系统队列是否存在，不打印、不联网。
/// DNS 解析和 connect_timeout 都是阻塞调用，同样走 blocking 线程池。
#[tauri::command]
pub async fn probe_printer(printer: PrinterProfileConfig) -> Result<ProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || printers::probe(&printer))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_printers(
    state: State<'_, AppState>,
    printers: Vec<PrinterProfileConfig>,
) -> Result<(), String> {
    let mut profiles: Vec<PrinterProfileConfig> = Vec::new();
    {
        let config = state.config.read().await;
        for printer in printers {
            let name = printer.name.trim();
            if name.is_empty() {
                continue;
            }
            if profiles
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(name))
            {
                return Err(format!("打印机名称重复：{name}"));
            }
            // 保存打印机不应该丢掉本地校准（重新发现后点保存是常规操作）。
            let existing = config
                .printers
                .iter()
                .find(|item| item.name.eq_ignore_ascii_case(name))
                .cloned();
            let calibration = existing
                .as_ref()
                .map(|item| item.calibration.clone())
                .unwrap_or_else(Calibration::default);
            profiles.push(PrinterProfileConfig {
                name: name.to_string(),
                kind: if printer.kind == "A4" || printer.kind == "BLUETOOTH" {
                    printer.kind
                } else {
                    "THERMAL".to_string()
                },
                connection: if printer.connection.is_empty() {
                    "SYSTEM_DRIVER".to_string()
                } else {
                    printer.connection
                },
                address: printer.address.filter(|value| !value.trim().is_empty()),
                format: if printer.format == "TSPL" {
                    "TSPL".to_string()
                } else {
                    "ZPL".to_string()
                },
                calibration,
            });
        }
    }
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

/// 打印测试页。可以传入 UI 里正在编辑但还没保存的打印机，避免「先存才能测」。
#[tauri::command]
pub async fn test_print(
    state: State<'_, AppState>,
    printer: Option<PrinterProfileConfig>,
) -> Result<Option<String>, String> {
    let profile = match printer {
        Some(printer) => printer,
        None => state
            .config
            .read()
            .await
            .printers
            .first()
            .cloned()
            .ok_or_else(|| "还没有保存打印机配置".to_string())?,
    };
    tauri::async_runtime::spawn_blocking(move || crate::printer::test_print(&profile))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
        .map(|path| path.map(|path| path.display().to_string()))
}
