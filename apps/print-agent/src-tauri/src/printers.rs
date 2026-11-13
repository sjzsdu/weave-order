use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::config::PrinterProfileConfig;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPrinter {
    pub name: String,
    pub kind: String,
    pub connection: String,
    pub address: Option<String>,
    pub format: String,
    pub status: String,
}

fn guess_kind(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if ["zebra", "tsc", "godex", "label", "thermal", "热敏", "标签"]
        .iter()
        .any(|key| lower.contains(key))
    {
        "THERMAL"
    } else {
        "A4"
    }
}

/// 系统打印队列发现。网络热敏打印机没有通用发现协议，
/// 由用户在 UI 里补 `host:9100`，保存后走 RAW TCP。
#[cfg(not(target_os = "windows"))]
pub fn discover() -> Vec<DiscoveredPrinter> {
    let output = Command::new("lpstat").args(["-p", "-d"]).output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut printers = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("printer ") {
            let name = rest.split_whitespace().next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let kind = guess_kind(&name);
            printers.push(DiscoveredPrinter {
                name: name.clone(),
                kind: kind.to_string(),
                connection: "SYSTEM_DRIVER".to_string(),
                address: Some(name),
                format: if kind == "THERMAL" { "ZPL" } else { "ZPL" }.to_string(),
                status: if line.contains("disabled") {
                    "OFFLINE".to_string()
                } else {
                    "READY".to_string()
                },
            });
        }
    }
    printers
}

#[cfg(target_os = "windows")]
pub fn discover() -> Vec<DiscoveredPrinter> {
    let script = "Get-Printer | Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or_default();
    let entries = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.get("Name")?.as_str()?.to_string();
            let port = entry.get("PortName").and_then(|value| value.as_str());
            let kind = guess_kind(&name);
            Some(DiscoveredPrinter {
                name: name.clone(),
                kind: kind.to_string(),
                connection: "SYSTEM_DRIVER".to_string(),
                address: Some(port.unwrap_or(&name).to_string()),
                format: "ZPL".to_string(),
                status: "READY".to_string(),
            })
        })
        .collect()
}

/// 把已保存的 profile 合并进发现结果（保留用户填的 host:9100 / 格式）。
pub fn merge(
    discovered: Vec<DiscoveredPrinter>,
    configured: &[PrinterProfileConfig],
) -> Vec<DiscoveredPrinter> {
    let mut result = Vec::new();
    for profile in configured {
        result.push(DiscoveredPrinter {
            name: profile.name.clone(),
            kind: profile.kind.clone(),
            connection: profile.connection.clone(),
            address: profile.address.clone(),
            format: profile.format.clone(),
            status: "READY".to_string(),
        });
    }
    for printer in discovered {
        if !result.iter().any(|item| item.name == printer.name) {
            result.push(printer);
        }
    }
    result
}
