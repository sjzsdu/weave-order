use std::io::Write;
use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine;

use crate::config::PrinterProfileConfig;
use crate::spool::SpoolJob;

fn is_terminal(kind: &str) -> bool {
    kind == "THERMAL" || kind == "BLUETOOTH"
}

/// 本地校准叠加：ZPL 用 ^LH/^MD，TSPL 用 SET DENSITY。
fn apply_calibration(payload: &str, format: &str, profile: &PrinterProfileConfig) -> String {
    let calibration = &profile.calibration;
    if format == "ZPL" {
        let mut text = payload.replacen(
            "^XA",
            &format!(
                "^XA\n^LH{},{}\n^MD{}",
                calibration.x_offset, calibration.y_offset, calibration.density
            ),
            1,
        );
        if !text.starts_with("^XA") {
            text = format!(
                "^XA\n^LH{},{}\n^MD{}\n{}",
                calibration.x_offset, calibration.y_offset, calibration.density, payload
            );
        }
        text
    } else if format == "TSPL" {
        format!(
            "SET DENSITY {}\n{}",
            calibration.density.clamp(0, 15),
            payload
        )
    } else {
        payload.to_string()
    }
}

fn raw_tcp(address: &str, payload: &str) -> Result<()> {
    let mut stream = TcpStream::connect(address)
        .with_context(|| format!("连接打印机 {address} 失败（RAW TCP 9100）"))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    stream.write_all(payload.as_bytes())?;
    stream.flush()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn print_pdf_file(path: &std::path::Path, printer_name: &str) -> Result<()> {
    let mut command = Command::new("lp");
    if !printer_name.trim().is_empty() {
        command.args(["-d", printer_name]);
    }
    let status = command
        .arg(path)
        .status()
        .context("调用 lp 打印失败（系统未安装 CUPS？）")?;
    if !status.success() {
        bail!("lp 打印失败，退出码 {status}");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn print_pdf_file(path: &std::path::Path, printer_name: &str) -> Result<()> {
    // 优先 SumatraPDF（支持 -print-to 指定打印机，静默）；否则回退系统默认打印。
    let sumatra = std::env::var("WEAVE_SUMATO_PATH").unwrap_or_else(|_| {
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe".to_string()
    });
    if std::path::Path::new(&sumatra).exists() {
        let status = Command::new(sumatra)
            .args([
                "-print-to",
                printer_name,
                "-silent",
                path.to_str().unwrap_or(""),
            ])
            .status()?;
        if !status.success() {
            bail!("SumatraPDF 打印失败，退出码 {status}");
        }
        return Ok(());
    }
    let script = format!(
        "Start-Process -FilePath '{}' -Verb PrintTo -ArgumentList '{}' -Wait",
        path.display(),
        printer_name.replace('\'', "''")
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()?;
    if !status.success() {
        bail!("Windows PrintTo 打印失败，退出码 {status}");
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn raw_system(payload: &str, printer_name: &str) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new()?;
    file.write_all(payload.as_bytes())?;
    let status = Command::new("lp")
        .args(["-d", printer_name, "-o", "raw"])
        .arg(file.path())
        .status()
        .context("调用 lp -o raw 失败")?;
    if !status.success() {
        bail!("lp -o raw 打印失败，退出码 {status}");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn raw_system(_payload: &str, printer_name: &str) -> Result<()> {
    Err(anyhow::anyhow!(
        "Windows 热敏打印机请把连接方式改成 RAW_TCP，并填 {printer_name} 的 IP:9100"
    ))
}

/// 执行一张打印任务：A4 走 PDF + 系统驱动；标签走 RAW TCP / 原始队列。
/// 打印载荷只在本机内存和 ≤24h 的 spool 里出现。
pub fn print_job(job: &SpoolJob, profile: &PrinterProfileConfig) -> Result<()> {
    let copies = job.copies.max(1);
    for copy in 0..copies {
        if job.format == "HTML" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(job.payload.as_bytes())
                .context("PDF 载荷不是合法 base64")?;
            let mut file = tempfile::Builder::new().suffix(".pdf").tempfile()?;
            file.write_all(&bytes)?;
            print_pdf_file(file.path(), &profile.name)?;
        } else {
            let payload = apply_calibration(&job.payload, &job.format, profile);
            if is_terminal(&profile.kind) {
                if let Some(address) = profile.address.as_deref() {
                    if address.contains(':') {
                        raw_tcp(address, &payload)?;
                        continue;
                    }
                }
                raw_system(&payload, &profile.name)?;
            } else {
                // A4 打印机收到标签模板：按纯文本走系统队列，避免静默丢单。
                raw_system(&payload, &profile.name)?;
            }
        }
        tracing::debug!(job = %job.id, copy, "printed copy");
    }
    Ok(())
}

/// 新打印机必须打一张测试标签：对齐、浓度、二维码可扫才算配置完成。
pub fn test_print(profile: &PrinterProfileConfig) -> Result<()> {
    let marker = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let test_job = if is_terminal(&profile.kind) && profile.format == "TSPL" {
        SpoolJob {
            id: format!("test-{marker}"),
            format: "TSPL".to_string(),
            copies: 1,
            payload: format!(
                "SIZE 100 mm,60 mm\nGAP 2 mm,0 mm\nCLS\nTEXT 20,20,\"TSS24.BF2\",0,1,1,\"织序测试标签\"\nTEXT 20,70,\"TSS16.BF2\",0,1,1,\"{marker}\"\nQRCODE 20,120,L,5,A,0,\"TEST/{marker}\"\nPRINT 1,1\n"
            ),
            printer_id: None,
            printer_name: Some(profile.name.clone()),
            printer_kind: Some(profile.kind.clone()),
        }
    } else if is_terminal(&profile.kind) {
        SpoolJob {
            id: format!("test-{marker}"),
            format: "ZPL".to_string(),
            copies: 1,
            payload: format!(
                "^XA\n^PW812\n^LL406\n^CI28\n^FO40,40^A0N,42,42^FD织序测试标签^FS\n^FO40,110^A0N,28,28^FD{marker}^FS\n^FO40,160^BQN,2,7^FDMA,TEST/{marker}^FS\n^XZ"
            ),
            printer_id: None,
            printer_name: Some(profile.name.clone()),
            printer_kind: Some(profile.kind.clone()),
        }
    } else {
        // A4：打一页纯文本测试页，确认队列和纸路。
        let text = format!("WeaveOrder Print Agent 测试页\n{marker}\n如果这张纸能打出来，A4 打印机配置正确。\n");
        let mut file = tempfile::Builder::new().suffix(".txt").tempfile()?;
        file.write_all(text.as_bytes())?;
        print_pdf_file(file.path(), &profile.name)?;
        return Ok(());
    };
    print_job(&test_job, profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Calibration;

    fn profile(kind: &str, format: &str) -> PrinterProfileConfig {
        PrinterProfileConfig {
            name: "printer".to_string(),
            kind: kind.to_string(),
            connection: "RAW_TCP".to_string(),
            address: Some("127.0.0.1:9100".to_string()),
            format: format.to_string(),
            calibration: Calibration::default(),
        }
    }

    #[test]
    fn zpl_calibration_is_injected_right_after_start() {
        let out = apply_calibration("^XA\n^FDhi^FS\n^XZ", "ZPL", &profile("THERMAL", "ZPL"));
        assert_eq!(out, "^XA\n^LH0,0\n^MD8\n^FDhi^FS\n^XZ");
    }

    #[test]
    fn zpl_payload_without_start_gets_full_header() {
        let out = apply_calibration("^FDhi^FS", "ZPL", &profile("THERMAL", "ZPL"));
        assert_eq!(out, "^XA\n^LH0,0\n^MD8\n^FDhi^FS");
    }

    #[test]
    fn tspl_density_is_clamped_to_printer_range() {
        let mut target = profile("THERMAL", "TSPL");
        target.calibration.density = 99;
        assert_eq!(
            apply_calibration("CLS\n", "TSPL", &target),
            "SET DENSITY 15\nCLS\n"
        );
    }

    #[test]
    fn unknown_format_passes_through_untouched() {
        assert_eq!(apply_calibration("raw", "PDF", &profile("A4", "PDF")), "raw");
    }
}
