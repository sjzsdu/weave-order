const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const logLines = [];

function log(message) {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logLines.unshift(`[${stamp}] ${message}`);
  $("log").textContent = logLines.slice(0, 80).join("\n");
}

function setStatus(status, text) {
  const el = $("status");
  el.className = `status ${status}`;
  el.textContent = text;
}

async function loadConfig() {
  try {
    const config = await invoke("get_config");
    $("serverUrl").value = config.serverUrl ?? "";
    $("token").value = config.token ?? "";
    $("agentName").value = config.agentName ?? "打印代理";
    if (config.serverUrl && config.token) {
      setStatus("offline", "连接中…");
    }
  } catch (error) {
    log(`读取配置失败：${error}`);
  }
}

async function loadPrinters() {
  try {
    const printers = await invoke("discovered_printers");
    const list = $("printers");
    list.innerHTML = "";
    for (const printer of printers) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <strong>${printer.name}</strong><br />
          <small>${printer.kind} · ${printer.connection}</small>
        </div>
        <div>
          <input data-name="${printer.name}" data-field="address" value="${printer.address ?? ""}" placeholder="host:9100 或系统队列" />
          <input data-name="${printer.name}" data-field="format" value="${printer.format ?? "ZPL"}" placeholder="ZPL/TSPL" />
        </div>`;
      list.appendChild(li);
      li._printer = printer;
    }
    log(`发现 ${printers.length} 台打印机`);
  } catch (error) {
    log(`发现打印机失败：${error}`);
  }
}

$("save").addEventListener("click", async () => {
  try {
    await invoke("save_config", {
      serverUrl: $("serverUrl").value.trim(),
      token: $("token").value.trim(),
      agentName: $("agentName").value.trim() || "打印代理",
    });
    log("配置已保存，正在重连");
    setStatus("offline", "连接中…");
  } catch (error) {
    log(`保存失败：${error}`);
    setStatus("error", "配置错误");
  }
});

$("discover").addEventListener("click", () => void loadPrinters());

$("savePrinters").addEventListener("click", async () => {
  const items = [...$("printers").children].map((li) => {
    const base = li._printer;
    const address = li.querySelector('[data-field="address"]').value.trim();
    const format = li.querySelector('[data-field="format"]').value.trim().toUpperCase();
    return {
      ...base,
      address: address || base.address,
      format: format === "TSPL" ? "TSPL" : "ZPL",
    };
  });
  try {
    await invoke("save_printers", { printers: items });
    log("打印机 profile 已保存，心跳会同步到云端");
  } catch (error) {
    log(`保存打印机失败：${error}`);
  }
});

$("test").addEventListener("click", async () => {
  try {
    await invoke("test_print");
    log("测试标签已发送");
  } catch (error) {
    log(`测试打印失败：${error}`);
  }
});

$("clear").addEventListener("click", async () => {
  if (!confirm("清空本地 spool 与日志？未打印的任务会丢失。")) return;
  try {
    await invoke("clear_local_data");
    log("本地数据已清空");
    await refreshSpool();
  } catch (error) {
    log(`清空失败：${error}`);
  }
});

async function refreshSpool() {
  try {
    const status = await invoke("spool_status");
    $("pending").textContent = status.pending;
    $("failed").textContent = status.failed;
  } catch (error) {
    log(`读取 spool 失败：${error}`);
  }
}

await loadConfig();
await loadPrinters();
await refreshSpool();

await listen("agent-status", (event) => {
  const { status, message } = event.payload;
  setStatus(status, message);
  log(message);
  void refreshSpool();
});

await listen("agent-log", (event) => log(event.payload.message));
setInterval(refreshSpool, 5000);
