use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::printer::print_job;
use crate::spool::SpoolJob;
use crate::state::AppState;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn heartbeat_payload(config: &crate::config::AgentConfig) -> Value {
    let printers: Vec<Value> = config
        .printers
        .iter()
        .map(|profile| {
            json!({
                "name": profile.name,
                "kind": profile.kind,
                "connection": profile.connection,
                "address": profile.address.clone(),
                "capabilities": { "format": profile.format },
                "calibration": profile.calibration.clone(),
                "status": "READY"
            })
        })
        .collect();
    json!({ "type": "heartbeat", "appVersion": VERSION, "printers": printers })
}

/// WSS 出站长连接：不开入站端口；掉线自动重连，收到 wake 才 claim。
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(ws_loop(app.clone()));
    tauri::async_runtime::spawn(worker_loop(app));
}

async fn ws_loop(app: AppHandle) {
    loop {
        let state = app.state::<AppState>().inner().clone();
        let config = state.snapshot().await;
        let Some(url) = config.ws_url() else {
            // 没有云端配置不是故障：本地发现 / 检测 / 测试打印都照常可用。
            let message = if config.server_url.trim().is_empty() && config.token.trim().is_empty() {
                "本地模式：未连接云端，打印机照常可用"
            } else {
                "云端配置不完整，请在「云端」页补齐地址与 token"
            };
            state.emit_status("local", message);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(15)) => {}
                _ = state.config_notify.notified() => {}
            }
            continue;
        };

        match connect_async(url.as_str()).await {
            Ok((mut socket, _)) => {
                state.emit_status("online", "已连接云端打印队列");
                let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
                heartbeat.tick().await;
                loop {
                    tokio::select! {
                        _ = heartbeat.tick() => {
                            let payload = heartbeat_payload(&state.snapshot().await);
                            if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                        _ = state.config_notify.notified() => {
                            let _ = socket.close(None).await;
                            break;
                        }
                        message = socket.next() => {
                            match message {
                                Some(Ok(Message::Text(text))) => {
                                    if handle_server_message(&state, &mut socket, text.as_str()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(Ok(Message::Ping(payload))) => {
                                    let _ = socket.send(Message::Pong(payload)).await;
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(error)) => {
                                    state.emit_log(&format!("连接错误：{error}"));
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }
                state.emit_status("offline", "连接已断开，正在重连…");
            }
            Err(error) => {
                state.emit_status("offline", &format!("连接失败：{error}"));
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = state.config_notify.notified() => {}
        }
    }
}

async fn handle_server_message<S>(
    state: &AppState,
    socket: &mut S,
    text: &str,
) -> anyhow::Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let value: Value = serde_json::from_str(text).unwrap_or_default();
    match value.get("type").and_then(Value::as_str) {
        Some("hello") => {
            state.emit_log("云端握手完成");
        }
        Some("wake") => {
            let _ = socket
                .send(Message::Text(
                    json!({ "type": "claim", "limit": 10 }).to_string().into(),
                ))
                .await;
        }
        Some("jobs") => {
            let jobs: Vec<SpoolJob> =
                serde_json::from_value(value.get("jobs").cloned().unwrap_or_else(|| json!([])))
                    .unwrap_or_default();
            let mut added = 0;
            for job in jobs {
                if state.spool.enqueue(&job).unwrap_or(false) {
                    added += 1;
                }
            }
            if added > 0 {
                state.emit_log(&format!("收到 {added} 个打印任务，已进入本地队列"));
                state.jobs_notify.notify_waiters();
            }
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("云端返回错误");
            state.emit_log(message);
        }
        _ => {}
    }
    Ok(())
}

/// 本地执行器：先出纸，再回报；网络不通时结果留在 spool，联网后补传。
async fn worker_loop(app: AppHandle) {
    loop {
        let state = app.state::<AppState>().inner().clone();
        let _ = state.spool.cleanup_expired();

        if let Ok(Some(job)) = state.spool.next_pending() {
            let config = state.snapshot().await;
            let profile = config
                .printers
                .iter()
                .find(|printer| {
                    job.printer_name
                        .as_deref()
                        .map(|name| name == printer.name)
                        .unwrap_or(false)
                })
                .or_else(|| {
                    job.printer_kind.as_deref().and_then(|kind| {
                        config.printers.iter().find(|printer| printer.kind == kind)
                    })
                })
                .or_else(|| config.printers.first());

            match profile {
                Some(profile) => match print_job(&job, profile) {
                    Ok(()) => {
                        state.emit_log(&format!("任务 {} 已出纸", short(&job.id)));
                        let _ = state.spool.mark_printed(&job.id);
                    }
                    Err(error) => {
                        state.emit_log(&format!("任务 {} 打印失败：{error}", short(&job.id)));
                        let _ = state.spool.mark_failed(&job.id, &error.to_string());
                    }
                },
                None => {
                    let _ = state.spool.mark_failed(&job.id, "没有匹配的打印机 profile");
                }
            }
        }

        if let Ok(unreported) = state.spool.unreported() {
            for (id, status, error) in unreported {
                if report_result(&state, &id, &status, error.as_deref()).await {
                    let _ = state.spool.mark_reported(&id);
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

async fn report_result(state: &AppState, job_id: &str, status: &str, error: Option<&str>) -> bool {
    let config = state.snapshot().await;
    if config.server_url.trim().is_empty() || config.token.trim().is_empty() {
        return false;
    }
    let url = format!("{}/api/print/agent/result", config.api_base());
    let body = json!({
        "jobId": job_id,
        "status": if status == "printed" { "DONE" } else { "FAILED" },
        "message": error,
    });
    match state
        .client
        .post(url)
        .bearer_auth(&config.token)
        .json(&body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            state.emit_log(&format!("回执被拒：HTTP {}", response.status().as_u16()));
            false
        }
        Err(_) => false,
    }
}
