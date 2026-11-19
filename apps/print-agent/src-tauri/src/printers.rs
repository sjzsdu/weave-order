use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::config::PrinterProfileConfig;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPrinter {
    pub name: String,
    pub kind: String,
    pub connection: String,
    pub address: Option<String>,
    pub format: String,
    pub status: String,
}

/// 发现结果附带诊断信息：小客户端里最怕「点了没反应」，必须能直接看到为什么。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub printers: Vec<DiscoveredPrinter>,
    pub platform: String,
    pub tool: String,
    pub ok: bool,
    pub message: String,
    pub hint: String,
}

impl DiscoveryReport {
    fn failed(
        platform: &str,
        tool: &str,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            printers: Vec::new(),
            platform: platform.to_string(),
            tool: tool.to_string(),
            ok: false,
            message: message.into(),
            hint: hint.into(),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
    missing: bool,
}

fn run(program: &str, args: &[&str]) -> CommandOutput {
    match Command::new(program).args(args).output() {
        Ok(output) => CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            missing: false,
        },
        Err(error) => CommandOutput {
            success: false,
            stdout: String::new(),
            stderr: error.to_string(),
            missing: error.kind() == std::io::ErrorKind::NotFound,
        },
    }
}

fn platform_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "未知平台"
    }
}

/// PowerShell 的 `-EncodedCommand` 接收 UTF-16LE + base64。
/// 用它传脚本，用户输入（打印机名）只出现在编码后的参数里，不会被命令行再解释一次。
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn powershell_encoded(command: &str) -> String {
    let utf16: Vec<u8> = command
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

pub fn guess_kind(name: &str, driver: &str) -> &'static str {
    let haystack = format!("{name} {driver}").to_lowercase();
    if [
        "zebra",
        "zdesigner",
        "zpl",
        "tsc",
        "godex",
        "argox",
        "brother",
        "label",
        "thermal",
        "热敏",
        "标签",
        "快递",
    ]
    .iter()
    .any(|key| haystack.contains(key))
    {
        "THERMAL"
    } else {
        "A4"
    }
}

/// 系统队列名 → 地址。Windows 的 TCP/IP 端口名形如 `IP_192.168.1.20`，
/// 直接映射成 RAW TCP 9100，省掉用户手填。
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn address_from_port(port: &str, name: &str) -> (String, Option<String>) {
    let trimmed = port.trim();
    if let Some(rest) = trimmed.strip_prefix("IP_") {
        let host = rest.split('_').next().unwrap_or(rest);
        if !host.is_empty() {
            return ("RAW_TCP".to_string(), Some(format!("{host}:9100")));
        }
    }
    if trimmed.starts_with("USB") || trimmed.starts_with("usb") {
        return ("USB".to_string(), Some(name.to_string()));
    }
    if trimmed.is_empty()
        || trimmed == "PORTPROMPT:"
        || trimmed.starts_with("WSD")
        || trimmed.starts_with("nul")
    {
        return ("SYSTEM_DRIVER".to_string(), Some(name.to_string()));
    }
    ("SYSTEM_DRIVER".to_string(), Some(name.to_string()))
}

#[cfg(not(target_os = "windows"))]
pub fn discover() -> DiscoveryReport {
    let report = discover_cups();
    #[cfg(target_os = "macos")]
    {
        with_save_pdf_target(report)
    }
    #[cfg(not(target_os = "macos"))]
    {
        report
    }
}

#[cfg(any(target_os = "macos", test))]
fn with_save_pdf_target(mut report: DiscoveryReport) -> DiscoveryReport {
    let cups_count = report.printers.len();
    let cups_ok = report.ok;
    let cups_message = report.message.clone();
    let cups_hint = report.hint.clone();
    if !report
        .printers
        .iter()
        .any(|printer| printer.connection == "SAVE_PDF")
    {
        report.printers.push(DiscoveredPrinter {
            name: "另存为 PDF".to_string(),
            kind: "A4".to_string(),
            connection: "SAVE_PDF".to_string(),
            address: Some(crate::printer::DEFAULT_SAVE_PDF_DIRECTORY.to_string()),
            format: "ZPL".to_string(),
            status: "READY".to_string(),
        });
    }
    report.ok = true;
    report.tool = format!("{} + 内置 PDF", report.tool);
    report.message = if cups_count > 0 {
        format!("发现 {cups_count} 台系统打印队列和内置「另存为 PDF」")
    } else if cups_ok {
        "未发现系统打印队列，已添加内置「另存为 PDF」".to_string()
    } else {
        "系统打印队列不可用，但内置「另存为 PDF」可用".to_string()
    };
    let pdf_hint = format!(
        "PDF 默认保存到 {}，可在下方修改",
        crate::printer::DEFAULT_SAVE_PDF_DIRECTORY
    );
    report.hint = if cups_ok {
        [cups_hint, pdf_hint]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("；")
    } else {
        [cups_message, cups_hint, pdf_hint]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("；")
    };
    report
}

#[cfg(not(target_os = "windows"))]
fn discover_cups() -> DiscoveryReport {
    let platform = platform_label();
    let probe = run("lpstat", &["-e"]);
    if probe.missing {
        return DiscoveryReport::failed(
            platform,
            "lpstat",
            "未找到 lpstat：系统没有可用的 CUPS 打印服务",
            if cfg!(target_os = "macos") {
                "macOS 自带 CUPS，请确认「系统设置 → 打印机与扫描仪」里至少添加了一台打印机"
            } else {
                "安装 CUPS 客户端后重试：sudo apt install cups-client（或 dnf install cups-client），并启动服务：sudo systemctl enable --now cups"
            },
        );
    }
    if !probe.success {
        let stderr = if probe.stderr.is_empty() {
            "lpstat 执行失败".to_string()
        } else {
            probe.stderr.clone()
        };
        let hint = if stderr.to_lowercase().contains("not running")
            || stderr.contains("未运行")
            || stderr.contains("cannot connect")
        {
            "CUPS 服务未启动：Linux 执行 sudo systemctl start cups；macOS 执行 sudo launchctl kickstart -k system/org.cups.cupsd"
        } else {
            "确认当前用户可以访问 CUPS，或直接用「手动添加」填热敏打印机 IP:9100"
        };
        return DiscoveryReport::failed(platform, "lpstat -e", stderr, hint);
    }

    // lpstat -p 只用来补状态；失败不影响队列列表。
    let detail = run("lpstat", &["-p"]);
    let printers = parse_lpstat_printers(&probe.stdout, &detail.stdout);
    let message = if printers.is_empty() {
        "CUPS 运行正常，但本机还没有打印队列".to_string()
    } else {
        format!("发现 {} 台本机打印队列", printers.len())
    };
    let hint = if printers.is_empty() {
        "在系统设置里添加打印机后重试；热敏打印机可直接「手动添加」填 IP:9100".to_string()
    } else {
        String::new()
    };
    DiscoveryReport {
        printers,
        platform: platform.to_string(),
        tool: "lpstat".to_string(),
        ok: true,
        message,
        hint,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn parse_lpstat_printers(names: &str, detail: &str) -> Vec<DiscoveredPrinter> {
    let mut statuses = std::collections::HashMap::new();
    for line in detail.lines() {
        let Some(rest) = line.trim().strip_prefix("printer ") else {
            continue;
        };
        let Some(name) = rest.split_whitespace().next() else {
            continue;
        };
        let lower = line.to_lowercase();
        let status = if lower.contains("disabled") || lower.contains("offline") {
            "OFFLINE"
        } else {
            "READY"
        };
        statuses.insert(name.to_string(), status);
    }
    names
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let kind = guess_kind(name, "");
            DiscoveredPrinter {
                name: name.to_string(),
                kind: kind.to_string(),
                connection: "SYSTEM_DRIVER".to_string(),
                address: Some(name.to_string()),
                format: "ZPL".to_string(),
                status: statuses.get(name).copied().unwrap_or("READY").to_string(),
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
pub fn discover() -> DiscoveryReport {
    let platform = platform_label();
    let mut errors: Vec<String> = Vec::new();
    let mut printers = Vec::new();
    let mut tool = "Get-Printer".to_string();

    // 中文 Windows 的 PowerShell 5.1 走管道时默认用 OEM 编码，不显式设 UTF-8 会解析失败。
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | ConvertTo-Json -Compress";
    let encoded = powershell_encoded(script);
    let output = run(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded],
    );
    if output.missing {
        errors.push("未找到 PowerShell".to_string());
    } else if output.success {
        printers = parse_windows_printers(&output.stdout);
    } else if !output.stderr.is_empty() {
        errors.push(output.stderr.clone());
    }

    // 没有 PowerShell 或执行策略受限时，老系统上的 wmic 仍可用。
    if printers.is_empty() {
        let fallback = run(
            "wmic",
            &[
                "printer",
                "get",
                "name,portname,printerstatus",
                "/format:csv",
            ],
        );
        if fallback.success {
            let parsed = parse_wmic_printers(&fallback.stdout);
            if !parsed.is_empty() {
                printers = parsed;
                tool = "wmic".to_string();
            }
        } else if !fallback.missing && !fallback.stderr.is_empty() {
            errors.push(fallback.stderr.clone());
        }
    }

    if printers.is_empty() {
        let message = if errors.is_empty() {
            "系统里还没有安装任何打印机".to_string()
        } else {
            errors.join("；")
        };
        let mut report = DiscoveryReport::failed(
            platform,
            &tool,
            message,
            "在 Windows 设置 → 蓝牙和设备 → 打印机和扫描仪里添加打印机；热敏打印机用「手动添加」填 IP:9100",
        );
        report.ok = errors.is_empty();
        return report;
    }

    DiscoveryReport {
        message: format!("发现 {} 台本机打印队列", printers.len()),
        printers,
        platform: platform.to_string(),
        tool,
        ok: true,
        hint: String::new(),
    }
}

#[cfg(target_os = "windows")]
pub fn parse_windows_printers(text: &str) -> Vec<DiscoveredPrinter> {
    let cleaned = text.trim_start_matches('\u{feff}').trim();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(cleaned) else {
        return Vec::new();
    };
    let entries = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.get("Name")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let port = entry
                .get("PortName")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let driver = entry
                .get("DriverName")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let status = entry
                .get("PrinterStatus")
                .and_then(|value| value.as_u64())
                .map(|code| if code == 3 { "READY" } else { "OFFLINE" })
                .unwrap_or("READY");
            Some(windows_printer(&name, driver, port, status))
        })
        .collect()
}

#[cfg(target_os = "windows")]
pub fn parse_wmic_printers(text: &str) -> Vec<DiscoveredPrinter> {
    let mut printers = Vec::new();
    for line in text.lines().skip(1) {
        let columns: Vec<&str> = line.split(',').map(str::trim).collect();
        if columns.len() < 4 {
            continue;
        }
        let name = columns[1];
        if name.is_empty() {
            continue;
        }
        let port = columns[2];
        let code = columns[3].parse::<u64>().unwrap_or(3);
        let status = if code == 3 { "READY" } else { "OFFLINE" };
        printers.push(windows_printer(name, "", port, status));
    }
    printers
}

#[cfg(target_os = "windows")]
fn windows_printer(name: &str, driver: &str, port: &str, status: &str) -> DiscoveredPrinter {
    let kind = guess_kind(name, driver);
    let (connection, address) = address_from_port(port, name);
    DiscoveredPrinter {
        name: name.to_string(),
        kind: kind.to_string(),
        connection,
        address,
        format: "ZPL".to_string(),
        status: status.to_string(),
    }
}

/// 把已保存的 profile 合并进发现结果（保留用户填的 host:9100 / 格式）。
/// 已保存但系统里没发现的网络打印机仍然保留，只是状态标成 CONFIGURED。
pub fn merge(
    discovered: Vec<DiscoveredPrinter>,
    configured: &[PrinterProfileConfig],
) -> Vec<DiscoveredPrinter> {
    let mut result: Vec<DiscoveredPrinter> = Vec::new();
    for profile in configured {
        let live = discovered
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(&profile.name));
        result.push(DiscoveredPrinter {
            name: profile.name.clone(),
            kind: profile.kind.clone(),
            connection: profile.connection.clone(),
            address: profile.address.clone(),
            format: profile.format.clone(),
            status: live
                .map(|item| item.status.clone())
                .unwrap_or_else(|| "CONFIGURED".to_string()),
        });
    }
    for printer in discovered {
        if !result
            .iter()
            .any(|item| item.name.eq_ignore_ascii_case(&printer.name))
        {
            result.push(printer);
        }
    }
    result
}

/// 本地检测：不连接云端、不出纸，先回答「这台打印机现在能不能打」。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub target: String,
    pub detail: String,
}

pub fn probe(profile: &PrinterProfileConfig) -> ProbeResult {
    let address = profile.address.clone().unwrap_or_default();
    if profile.connection == "SAVE_PDF" {
        return probe_save_pdf(&address);
    }
    let raw = profile.connection == "RAW_TCP" || profile.connection == "BLUETOOTH";
    if raw {
        let target = normalize_raw_target(&address);
        return match target {
            None => ProbeResult {
                ok: false,
                target: address,
                detail: "地址格式不对，请填 IP:端口，例如 192.168.1.20:9100".to_string(),
            },
            Some(target) => probe_tcp(&target),
        };
    }
    probe_system_queue(&profile.name, &profile.connection)
}

fn probe_save_pdf(address: &str) -> ProbeResult {
    let target = if address.trim().is_empty() {
        crate::printer::DEFAULT_SAVE_PDF_DIRECTORY.to_string()
    } else {
        address.trim().to_string()
    };
    let result = crate::printer::pdf_directory(address).and_then(|directory| {
        std::fs::create_dir_all(&directory)?;
        tempfile::Builder::new()
            .prefix(".weave-print-probe-")
            .tempfile_in(&directory)?;
        Ok(directory)
    });
    match result {
        Ok(directory) => ProbeResult {
            ok: true,
            target: directory.display().to_string(),
            detail: "目录可写，测试 PDF 将保存到这里".to_string(),
        },
        Err(error) => ProbeResult {
            ok: false,
            target,
            detail: format!("PDF 保存目录不可用：{error}"),
        },
    }
}

fn normalize_raw_target(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() {
        return None;
    }
    let with_port = if address.contains(':') {
        address.to_string()
    } else {
        format!("{address}:9100")
    };
    let (host, port) = with_port.rsplit_once(':')?;
    if host.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    Some(with_port)
}

fn probe_tcp(target: &str) -> ProbeResult {
    let started = Instant::now();
    let addresses = match target.to_socket_addrs() {
        Ok(addresses) => addresses.collect::<Vec<_>>(),
        Err(error) => {
            return ProbeResult {
                ok: false,
                target: target.to_string(),
                detail: format!("地址解析失败：{error}"),
            }
        }
    };
    if addresses.is_empty() {
        return ProbeResult {
            ok: false,
            target: target.to_string(),
            detail: "地址无法解析，请检查 IP 或主机名".to_string(),
        };
    }

    // 主机名可能同时有 A / AAAA 记录：逐个试，整体最多等 3 秒。
    // 只取第一条会在「IPv6 记录在前、打印机只走 IPv4」时给出假阴性。
    let deadline = started + Duration::from_secs(3);
    let mut last_error = None;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(_) => {
                return ProbeResult {
                    ok: true,
                    target: target.to_string(),
                    detail: format!(
                        "可以连通（{} ms），点「测试打印」出纸确认对齐与浓度",
                        started.elapsed().as_millis()
                    ),
                }
            }
            Err(error) => last_error = Some(error),
        }
    }
    ProbeResult {
        ok: false,
        target: target.to_string(),
        detail: match last_error {
            Some(error) => {
                format!("连不上 9100 端口：{error}。确认打印机电源、网线和 IP，或改用系统驱动")
            }
            None => "连接超时：3 秒内没有可用地址应答".to_string(),
        },
    }
}

#[cfg(not(target_os = "windows"))]
fn probe_system_queue(name: &str, connection: &str) -> ProbeResult {
    let output = run("lpstat", &["-p", name]);
    let target = format!("系统队列 {name}（{connection}）");
    if output.missing {
        return ProbeResult {
            ok: false,
            target,
            detail: "未找到 lpstat：请安装 CUPS 客户端，或把连接方式改成 RAW TCP".to_string(),
        };
    }
    if output.success {
        let offline = output.stdout.to_lowercase().contains("disabled");
        ProbeResult {
            ok: !offline,
            target,
            detail: if offline {
                "队列存在但被禁用：在系统打印机设置里启用它".to_string()
            } else {
                "队列存在且可用，点「测试打印」出纸确认".to_string()
            },
        }
    } else {
        ProbeResult {
            ok: false,
            target,
            detail: format!(
                "系统里没有这个队列：{}",
                if output.stderr.is_empty() {
                    "请重新发现打印机"
                } else {
                    output.stderr.as_str()
                }
            ),
        }
    }
}

#[cfg(target_os = "windows")]
fn probe_system_queue(name: &str, connection: &str) -> ProbeResult {
    let script = format!(
        "$p = Get-Printer -Name '{}' -ErrorAction Stop; if ($p.PrinterStatus -eq 3) {{ 'READY' }} else {{ 'OFFLINE' }}",
        name.replace('\'', "''")
    );
    let encoded = powershell_encoded(&script);
    let output = run(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded],
    );
    let target = format!("系统队列 {name}（{connection}）");
    if output.missing {
        return ProbeResult {
            ok: false,
            target,
            detail: "未找到 PowerShell：请把连接方式改成 RAW TCP 并填 IP:9100".to_string(),
        };
    }
    if output.success {
        let offline = output.stdout.contains("OFFLINE");
        ProbeResult {
            ok: !offline,
            target,
            detail: if offline {
                "队列存在但状态异常：在 Windows 打印机设置里查看".to_string()
            } else {
                "队列存在且可用，点「测试打印」出纸确认".to_string()
            },
        }
    } else {
        ProbeResult {
            ok: false,
            target,
            detail: format!(
                "系统里没有这个队列：{}",
                if output.stderr.is_empty() {
                    "请重新发现打印机"
                } else {
                    output.stderr.as_str()
                }
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_pdf_target_is_available_without_cups_and_not_duplicated() {
        let failed = DiscoveryReport::failed("macOS", "lpstat", "CUPS 不可用", "检查 CUPS");
        let report = with_save_pdf_target(with_save_pdf_target(failed));
        assert!(report.ok);
        assert_eq!(report.printers.len(), 1);
        assert_eq!(report.printers[0].connection, "SAVE_PDF");
        assert_eq!(report.printers[0].kind, "A4");
        assert!(report.hint.contains("CUPS 不可用"));
        assert!(report.hint.contains("PDF 默认保存到"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn lpstat_queue_names_become_printers() {
        let printers = parse_lpstat_printers(
            "Zebra_ZD421\nHP_LaserJet\n",
            "printer Zebra_ZD421 is idle.  enabled since Thu\nprinter HP_LaserJet disabled since Thu",
        );
        assert_eq!(printers.len(), 2);
        assert_eq!(printers[0].name, "Zebra_ZD421");
        assert_eq!(printers[0].kind, "THERMAL");
        assert_eq!(printers[0].status, "READY");
        assert_eq!(printers[1].kind, "A4");
        assert_eq!(printers[1].status, "OFFLINE");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn lpstat_unknown_queue_defaults_to_ready() {
        let printers = parse_lpstat_printers("OnlyQueue", "");
        assert_eq!(printers.len(), 1);
        assert_eq!(printers[0].status, "READY");
        assert_eq!(printers[0].connection, "SYSTEM_DRIVER");
    }

    #[test]
    fn kind_uses_driver_when_name_is_generic() {
        assert_eq!(guess_kind("Printer 1", "ZDesigner ZD421"), "THERMAL");
        assert_eq!(guess_kind("标签机", ""), "THERMAL");
        assert_eq!(guess_kind("HP LaserJet", "HP Universal"), "A4");
    }

    #[test]
    fn windows_tcp_port_maps_to_raw_tcp_address() {
        assert_eq!(
            address_from_port("IP_192.168.1.20", "Zebra"),
            ("RAW_TCP".to_string(), Some("192.168.1.20:9100".to_string()))
        );
        assert_eq!(
            address_from_port("USB001", "Zebra"),
            ("USB".to_string(), Some("Zebra".to_string()))
        );
    }

    #[test]
    fn merge_keeps_user_address_and_marks_live_status() {
        let configured = vec![PrinterProfileConfig {
            name: "Zebra".to_string(),
            kind: "THERMAL".to_string(),
            connection: "RAW_TCP".to_string(),
            address: Some("10.0.0.9:9100".to_string()),
            format: "TSPL".to_string(),
            calibration: crate::config::Calibration::default(),
        }];
        let discovered = vec![DiscoveredPrinter {
            name: "zebra".to_string(),
            kind: "THERMAL".to_string(),
            connection: "SYSTEM_DRIVER".to_string(),
            address: Some("zebra".to_string()),
            format: "ZPL".to_string(),
            status: "OFFLINE".to_string(),
        }];
        let merged = merge(discovered, &configured);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].address.as_deref(), Some("10.0.0.9:9100"));
        assert_eq!(merged[0].format, "TSPL");
        assert_eq!(merged[0].status, "OFFLINE");
    }

    #[test]
    fn configured_printer_missing_from_system_is_kept() {
        let merged = merge(
            Vec::new(),
            &[PrinterProfileConfig {
                name: "仓库热敏".to_string(),
                kind: "THERMAL".to_string(),
                connection: "RAW_TCP".to_string(),
                address: Some("192.168.1.20:9100".to_string()),
                format: "ZPL".to_string(),
                calibration: crate::config::Calibration::default(),
            }],
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].status, "CONFIGURED");
    }

    #[test]
    fn raw_target_defaults_port_and_rejects_garbage() {
        assert_eq!(
            normalize_raw_target("192.168.1.20").as_deref(),
            Some("192.168.1.20:9100")
        );
        assert_eq!(
            normalize_raw_target("192.168.1.20:6101").as_deref(),
            Some("192.168.1.20:6101")
        );
        assert_eq!(normalize_raw_target("  "), None);
        assert_eq!(normalize_raw_target(":9100"), None);
        assert_eq!(normalize_raw_target("host:abc"), None);
    }

    #[test]
    fn powershell_encoded_command_is_utf16le_base64() {
        let encoded = powershell_encoded("Get-Printer");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64");
        assert_eq!(bytes.len(), "Get-Printer".len() * 2);
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).expect("utf16"), "Get-Printer");
    }

    #[test]
    fn powershell_encoded_command_survives_quotes_and_chinese() {
        let script = "$p = Get-Printer -Name '仓库''热敏'";
        let encoded = powershell_encoded(script);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64");
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).expect("utf16"), script);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_json_printer_entries_are_mapped() {
        let printers = parse_windows_printers(
            r#"[{"Name":"Zebra ZD421","DriverName":"ZDesigner","PortName":"IP_192.168.1.20","PrinterStatus":3},{"Name":"HP","DriverName":"HP Universal","PortName":"WSD-abc","PrinterStatus":4}]"#,
        );
        assert_eq!(printers.len(), 2);
        assert_eq!(printers[0].connection, "RAW_TCP");
        assert_eq!(printers[0].address.as_deref(), Some("192.168.1.20:9100"));
        assert_eq!(printers[0].status, "READY");
        assert_eq!(printers[1].status, "OFFLINE");
    }
}
