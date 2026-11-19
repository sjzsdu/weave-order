use std::fs::OpenOptions;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine;

use crate::config::PrinterProfileConfig;
use crate::spool::SpoolJob;

pub const DEFAULT_SAVE_PDF_DIRECTORY: &str = "~/Downloads/织序打印";

pub fn pdf_directory(address: &str) -> Result<PathBuf> {
    let configured = if address.trim().is_empty() {
        DEFAULT_SAVE_PDF_DIRECTORY
    } else {
        address.trim()
    };
    let path = if configured == "~" {
        home_directory()?
    } else if let Some(rest) = configured.strip_prefix("~/") {
        home_directory()?.join(rest)
    } else {
        PathBuf::from(configured)
    };
    if !path.is_absolute() {
        bail!("PDF 保存目录必须是绝对路径，或以 ~/ 开头");
    }
    Ok(path)
}

fn home_directory() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .context("无法确定用户主目录，请填写 PDF 保存目录的绝对路径")
}

fn safe_file_stem(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "print".to_string()
    } else {
        trimmed.to_string()
    }
}

fn save_pdf_document(
    bytes: &[u8],
    job_id: &str,
    copy: i64,
    profile: &PrinterProfileConfig,
) -> Result<PathBuf> {
    let directory = pdf_directory(profile.address.as_deref().unwrap_or(""))?;
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("创建 PDF 保存目录 {} 失败", directory.display()))?;
    let mut stem = safe_file_stem(job_id);
    if copy > 0 {
        stem = format!("{stem}-{}", copy + 1);
    }

    for duplicate in 0..1000 {
        let filename = if duplicate == 0 {
            format!("{stem}.pdf")
        } else {
            format!("{stem}-{duplicate}.pdf")
        };
        let path = directory.join(filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(error).with_context(|| format!("写入 PDF {} 失败", path.display()));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("创建 PDF {} 失败", path.display()));
            }
        }
    }
    bail!("PDF 保存目录中同名文件过多，请清理后重试")
}

fn test_pdf(marker: &str) -> Vec<u8> {
    let marker = marker
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)");
    let stream = format!(
        "BT\n/F1 18 Tf\n72 740 Td\n(WeaveOrder Print Agent) Tj\n0 -32 Td\n/F1 11 Tf\n(PDF export test) Tj\n0 -20 Td\n({marker}) Tj\nET"
    );
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
    ];
    let mut pdf = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        writeln!(&mut pdf, "{} 0 obj\n{}\nendobj", index + 1, object).expect("write PDF object");
    }
    let xref = pdf.len();
    writeln!(
        &mut pdf,
        "xref\n0 {}\n0000000000 65535 f ",
        objects.len() + 1
    )
    .expect("write PDF xref");
    for offset in offsets {
        writeln!(&mut pdf, "{offset:010} 00000 n ").expect("write PDF xref entry");
    }
    write!(
        &mut pdf,
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        objects.len() + 1,
        xref
    )
    .expect("write PDF trailer");
    pdf
}

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
    let sumatra = std::env::var("WEAVE_SUMATO_PATH")
        .unwrap_or_else(|_| r"C:\Program Files\SumatraPDF\SumatraPDF.exe".to_string());
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
    if profile.connection == "SAVE_PDF" && job.format != "HTML" {
        bail!("「另存为 PDF」只支持 PDF 单证，不能导出标签指令");
    }
    let copies = job.copies.max(1);
    for copy in 0..copies {
        if job.format == "HTML" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(job.payload.as_bytes())
                .context("PDF 载荷不是合法 base64")?;
            if profile.connection == "SAVE_PDF" {
                let path = save_pdf_document(&bytes, &job.id, copy, profile)?;
                tracing::debug!(job = %job.id, path = %path.display(), "saved PDF copy");
            } else {
                let mut file = tempfile::Builder::new().suffix(".pdf").tempfile()?;
                file.write_all(&bytes)?;
                print_pdf_file(file.path(), &profile.name)?;
            }
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
pub fn test_print(profile: &PrinterProfileConfig) -> Result<Option<PathBuf>> {
    let marker = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    if profile.connection == "SAVE_PDF" {
        let path = save_pdf_document(&test_pdf(&marker), &format!("test-{marker}"), 0, profile)?;
        return Ok(Some(path));
    }
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
        let text = format!(
            "WeaveOrder Print Agent 测试页\n{marker}\n如果这张纸能打出来，A4 打印机配置正确。\n"
        );
        let mut file = tempfile::Builder::new().suffix(".txt").tempfile()?;
        file.write_all(text.as_bytes())?;
        print_pdf_file(file.path(), &profile.name)?;
        return Ok(None);
    };
    print_job(&test_job, profile)?;
    Ok(None)
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
        assert_eq!(
            apply_calibration("raw", "PDF", &profile("A4", "PDF")),
            "raw"
        );
    }

    #[test]
    fn pdf_export_sanitizes_names_and_never_overwrites() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut target = profile("A4", "ZPL");
        target.connection = "SAVE_PDF".to_string();
        target.address = Some(directory.path().display().to_string());
        let bytes = test_pdf("20261119-test");
        let first = save_pdf_document(&bytes, "../../订单/42", 0, &target).expect("first PDF");
        let second = save_pdf_document(&bytes, "../../订单/42", 0, &target).expect("second PDF");

        assert_eq!(first.parent(), Some(directory.path()));
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).expect("read first PDF"), bytes);
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn pdf_print_job_exports_each_copy() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut target = profile("A4", "ZPL");
        target.connection = "SAVE_PDF".to_string();
        target.address = Some(directory.path().display().to_string());
        let bytes = test_pdf("20261119-copies");
        let job = SpoolJob {
            id: "cloud-job".to_string(),
            format: "HTML".to_string(),
            copies: 2,
            payload: base64::engine::general_purpose::STANDARD.encode(&bytes),
            printer_id: None,
            printer_name: None,
            printer_kind: Some("A4".to_string()),
        };

        print_job(&job, &target).expect("export copies");
        assert_eq!(
            std::fs::read(directory.path().join("cloud-job.pdf")).expect("first copy"),
            bytes
        );
        assert_eq!(
            std::fs::read(directory.path().join("cloud-job-2.pdf")).expect("second copy"),
            bytes
        );
    }

    #[test]
    fn pdf_directory_rejects_relative_paths() {
        assert!(pdf_directory("relative/output").is_err());
    }
}
