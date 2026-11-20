const tauri = window.__TAURI__;
const preview = !tauri;
// __TAURI_INTERNALS__ 由 Tauri 无条件注入；它存在而 __TAURI__ 不存在，
// 说明是 WebView 里 withGlobalTauri 配置回归，不能当成「浏览器预览」静默降级。
const tauriApiMissing = preview && Boolean(window.__TAURI_INTERNALS__);

const invoke = preview
  ? (await import("./preview.js")).createPreviewBridge()
  : tauri.core.invoke;
const listen = preview ? async () => () => {} : tauri.event.listen;

const $ = (id) => document.getElementById(id);
const MAX_LOG = 300;
const logLines = [];

const STATUS_TEXT = {
  online: "已连接",
  local: "本地",
  offline: "离线",
  error: "错误",
};

const MODE_TEXT = {
  online: "已连接云端 · 自动接收打印任务",
  local: "打开即用 · 仅本地模式",
  offline: "云端离线 · 本地打印继续可用",
  error: "配置有误 · 本地功能仍可用",
};

const PRINTER_STATUS_TEXT = {
  READY: "就绪",
  OFFLINE: "离线",
  CONFIGURED: "已保存",
};

const KIND_OPTIONS = [
  ["THERMAL", "热敏标签"],
  ["A4", "A4 文档"],
  ["BLUETOOTH", "蓝牙标签"],
];

const CONNECTION_OPTIONS = [
  ["SYSTEM_DRIVER", "系统驱动"],
  ["SAVE_PDF", "另存为 PDF"],
  ["RAW_TCP", "网络 RAW TCP"],
  ["USB", "USB 队列"],
  ["BLUETOOTH", "蓝牙"],
];

const ADDRESS_PLACEHOLDER = {
  RAW_TCP: "192.168.1.20:9100",
  BLUETOOTH: "蓝牙设备名",
  SYSTEM_DRIVER: "系统队列名（留空则用打印机名）",
  USB: "系统队列名",
  SAVE_PDF: "~/Downloads/织序打印",
};

let printers = [];

function log(message) {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logLines.push(`[${stamp}] ${message}`);
  if (logLines.length > MAX_LOG) logLines.splice(0, logLines.length - MAX_LOG);
  const el = $("log");
  el.textContent = logLines.join("\n");
  el.scrollTop = el.scrollHeight;
}

function applyStatus(status, message) {
  const el = $("status");
  el.className = `status ${status}`;
  el.textContent = STATUS_TEXT[status] ?? status;
  $("modeLine").textContent = message || MODE_TEXT[status] || "";
}

function showMessage(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
}

function hideMessage(id) {
  $(id).hidden = true;
}

function switchTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  }
}

function makeSelect(options, value, onChange) {
  const select = document.createElement("select");
  const known = options.some(([optionValue]) => optionValue === value);
  const all = known ? options : [...options, [value, value]];
  for (const [optionValue, label] of all) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function makeField(labelText, control) {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function buildProfile(printer) {
  return {
    name: (printer.name || "").trim(),
    kind: printer.connection === "SAVE_PDF" ? "A4" : printer.kind || "THERMAL",
    connection: printer.connection || "SYSTEM_DRIVER",
    address: (printer.address || "").trim() || null,
    format: printer.format === "TSPL" ? "TSPL" : "ZPL",
  };
}

function printerCard(printer, index) {
  const card = document.createElement("li");
  card.className = "printer";

  const head = document.createElement("div");
  head.className = "printer-head";

  const identity = document.createElement("div");
  identity.className = "printer-identity";

  // 打印机名来自本机队列/用户输入，按不可信文本处理：只用 textContent / value。
  const nameInput = document.createElement("input");
  nameInput.className = "printer-name";
  nameInput.value = printer.name;
  nameInput.title = printer.name;
  nameInput.maxLength = 64;
  nameInput.setAttribute("aria-label", "打印机名称");
  nameInput.addEventListener("input", () => {
    printer.name = nameInput.value;
    nameInput.title = printer.name;
    refreshTestTarget();
  });

  const chip = document.createElement("span");
  chip.className = "chip";
  chip.dataset.status = printer.status || "CONFIGURED";
  chip.textContent = PRINTER_STATUS_TEXT[printer.status] ?? "已保存";

  identity.append(nameInput, chip);

  const buttons = document.createElement("div");
  buttons.className = "printer-buttons";
  buttons.append(
    actionButton("检测", () => probePrinter(printer, card)),
    actionButton("测试打印", () => testPrinter(printer, card)),
    actionButton(
      "移除",
      () => {
        printers.splice(index, 1);
        renderPrinters();
        log(`已从列表移除 ${printer.name || "打印机"}（保存后生效）`);
      },
      "button small danger ghost",
    ),
  );

  head.append(identity, buttons);

  const grid = document.createElement("div");
  grid.className = "printer-grid";

  const formatLabel = makeField(
    "标签格式",
    makeSelect(
      [
        ["ZPL", "ZPL（Zebra 等）"],
        ["TSPL", "TSPL（TSC 等）"],
      ],
      printer.format === "TSPL" ? "TSPL" : "ZPL",
      (value) => {
        printer.format = value;
      },
    ),
  );

  const addressInput = document.createElement("input");
  addressInput.value = printer.address ?? "";
  addressInput.title = printer.address ?? "";
  addressInput.placeholder = ADDRESS_PLACEHOLDER[printer.connection] ?? "";
  addressInput.spellcheck = false;
  addressInput.addEventListener("input", () => {
    printer.address = addressInput.value;
    addressInput.title = addressInput.value;
  });

  const syncFormatVisibility = () => {
    formatLabel.hidden = printer.kind !== "THERMAL";
  };

  const kindSelect = makeSelect(KIND_OPTIONS, printer.kind || "THERMAL", (value) => {
    printer.kind = value;
    syncFormatVisibility();
  });
  const addressLabel = makeField("地址 / 队列", addressInput);
  const syncConnection = () => {
    const savePdf = printer.connection === "SAVE_PDF";
    addressInput.placeholder = ADDRESS_PLACEHOLDER[printer.connection] ?? "";
    addressLabel.querySelector("span").textContent = savePdf ? "保存目录" : "地址 / 队列";
    kindSelect.disabled = savePdf;
    if (savePdf) {
      printer.kind = "A4";
      kindSelect.value = "A4";
    }
    syncFormatVisibility();
  };

  grid.append(
    makeField("类型", kindSelect),
    makeField(
      "连接方式",
      makeSelect(CONNECTION_OPTIONS, printer.connection || "SYSTEM_DRIVER", (value) => {
        printer.connection = value;
        syncConnection();
      }),
    ),
    addressLabel,
    formatLabel,
  );
  syncConnection();

  const probeLine = document.createElement("p");
  probeLine.className = "probe-line";
  probeLine.hidden = true;

  card.append(head, grid, probeLine);
  return card;
}

function actionButton(text, onClick, className = "button small") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function renderPrinters() {
  const list = $("printers");
  list.replaceChildren();
  printers.forEach((printer, index) => list.append(printerCard(printer, index)));
  $("printersEmpty").hidden = printers.length > 0;
  refreshTestTarget();
}

async function probePrinter(printer, card) {
  const line = card?.querySelector(".probe-line");
  if (!printer.name.trim() && !(printer.address || "").trim()) {
    if (line) {
      line.hidden = false;
      line.dataset.ok = "false";
      line.textContent = "先填打印机名称和地址（网络打印机形如 192.168.1.20:9100）";
    }
    return;
  }
  if (line) {
    line.hidden = false;
    line.dataset.ok = "";
    line.textContent = "检测中…";
  }
  try {
    const result = await invoke("probe_printer", { printer: buildProfile(printer) });
    if (line) {
      line.hidden = false;
      line.dataset.ok = String(result.ok);
      line.textContent = `${result.ok ? "✓" : "✗"} ${result.target}：${result.detail}`;
    }
    log(`检测 ${printer.name || result.target}：${result.detail}`);
  } catch (error) {
    if (line) {
      line.hidden = false;
      line.dataset.ok = "false";
      line.textContent = `检测失败：${error}`;
    }
    log(`检测 ${printer.name || "打印机"} 失败：${error}`);
  }
}

async function testPrinter(printer, card) {
  const line = card?.querySelector(".probe-line");
  if (line) {
    line.hidden = false;
    line.dataset.ok = "";
    line.textContent = "正在发送测试页…";
  }
  try {
    const savedPath = await invoke("test_print", { printer: buildProfile(printer) });
    const message = savedPath
      ? `PDF 已保存：${savedPath}`
      : `已向 ${printer.name || "打印机"} 发送测试页`;
    if (line) {
      line.hidden = false;
      line.dataset.ok = "true";
      line.textContent = savedPath ? message : "测试页已发送，请取纸检查对齐、浓度和二维码";
    }
    log(message);
  } catch (error) {
    if (line) {
      line.hidden = false;
      line.dataset.ok = "false";
      line.textContent = `测试打印失败：${error}`;
    }
    log(`测试打印失败：${error}`);
  }
}

function renderDiscovery(report) {
  const el = $("discovery");
  const count = report.printers?.length ?? 0;
  el.dataset.state = report.ok ? (count > 0 ? "ok" : "empty") : "error";
  $("discoveryBadge").textContent = report.ok
    ? count > 0
      ? `发现 ${count} 台`
      : "未发现打印机"
    : "发现失败";
  $("discoveryMeta").textContent = [report.platform, report.tool].filter(Boolean).join(" · ");
  $("discoveryMessage").textContent = report.message || "";
  const hint = $("discoveryHint");
  hint.hidden = !report.hint;
  hint.textContent = report.hint || "";
}

async function loadPrinters() {
  try {
    const report = await invoke("discovered_printers");
    printers = report.printers ?? [];
    renderPrinters();
    renderDiscovery(report);
    log(report.message || `发现 ${printers.length} 台打印机`);
  } catch (error) {
    renderDiscovery({
      ok: false,
      platform: "",
      tool: "",
      message: `读取本机打印机失败：${error}`,
      hint: "点「手动添加」可以直接填热敏打印机 IP:9100，不依赖系统打印服务。",
    });
    renderPrinters();
    log(`发现打印机失败：${error}`);
  }
}

function refreshTestTarget() {
  const select = $("testTarget");
  const current = select.value;
  select.replaceChildren();
  if (printers.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "还没有打印机";
    select.append(option);
    return;
  }
  printers.forEach((printer, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = printer.name || `打印机 ${index + 1}`;
    select.append(option);
  });
  if (current !== "" && Number(current) < printers.length) {
    select.value = current;
  }
}

async function loadConfig() {
  try {
    const config = await invoke("get_config");
    $("serverUrl").value = config.serverUrl ?? "";
    $("token").value = config.token ?? "";
    $("agentName").value = config.agentName || "打印代理";
    // 注意：不在此处设置状态。状态由 agent 的 agent-status 事件驱动，
    // 避免覆盖 agent 在启动早期就已发出的「已连接」状态。
  } catch (error) {
    log(`读取配置失败：${error}`);
  }
}

async function refreshSpool() {
  try {
    const status = await invoke("spool_status");
    $("pending").textContent = status.pending;
    $("failed").textContent = status.failed;
    $("printed").textContent = status.printed;
  } catch (error) {
    log(`读取本地队列失败：${error}`);
  }
}

async function savePrinters() {
  const valid = printers.filter((printer) => printer.name.trim());
  if (valid.length !== printers.length) {
    showMessage("printersMessage", "打印机名称不能为空：请先填写名称，或移除该条目。", "error");
    return;
  }
  try {
    await invoke("save_printers", { printers: valid.map(buildProfile) });
    printers = valid;
    renderPrinters();
    showMessage(
      "printersMessage",
      `已保存 ${valid.length} 台打印机配置（本机生效，不需要云端）。`,
      "ok",
    );
    log(`打印机配置已保存：${valid.length} 台`);
  } catch (error) {
    showMessage("printersMessage", `保存失败：${error}`, "error");
    log(`保存打印机失败：${error}`);
  }
}

function bindEvents() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }

  $("discover").addEventListener("click", () => {
    hideMessage("printersMessage");
    void loadPrinters();
  });

  $("addPrinter").addEventListener("click", () => {
    printers.push({
      name: `新打印机 ${printers.length + 1}`,
      kind: "THERMAL",
      connection: "RAW_TCP",
      address: "",
      format: "ZPL",
      status: "CONFIGURED",
    });
    renderPrinters();
    const last = $("printers").lastElementChild;
    const input = last?.querySelector(".printer-name");
    input?.focus();
    input?.select();
  });

  $("savePrinters").addEventListener("click", () => void savePrinters());

  $("save").addEventListener("click", async () => {
    const serverUrl = $("serverUrl").value.trim();
    const token = $("token").value.trim();
    const agentName = $("agentName").value.trim() || "打印代理";
    try {
      await invoke("save_config", { serverUrl, token, agentName });
      const message = serverUrl ? "已保存，正在连接云端…" : "已切换为仅本地模式，打印机照常可用";
      showMessage("cloudMessage", message, "ok");
      applyStatus(serverUrl ? "offline" : "local", serverUrl ? "正在连接云端…" : MODE_TEXT.local);
      log(message);
    } catch (error) {
      showMessage("cloudMessage", `保存失败：${error}`, "error");
      applyStatus("error");
      log(`保存云端配置失败：${error}`);
    }
  });

  $("localOnly").addEventListener("click", async () => {
    const hadCloud = Boolean($("serverUrl").value.trim() || $("token").value.trim());
    if (hadCloud && !confirm("清除云端配置后，需要重新注册 token 才能再连云端。确定仅本地使用？")) {
      return;
    }
    $("serverUrl").value = "";
    $("token").value = "";
    try {
      await invoke("save_config", {
        serverUrl: "",
        token: "",
        agentName: $("agentName").value.trim() || "打印代理",
      });
      showMessage("cloudMessage", "已切换为仅本地模式，打印机照常可用", "ok");
      applyStatus("local", MODE_TEXT.local);
      log("已切换为仅本地模式");
    } catch (error) {
      showMessage("cloudMessage", `切换失败：${error}`, "error");
    }
  });

  $("test").addEventListener("click", async () => {
    const index = Number($("testTarget").value);
    const printer = printers[index];
    if (!printer) {
      showMessage("localMessage", "还没有打印机：先去「打印机」页发现或手动添加。", "error");
      return;
    }
    try {
      const savedPath = await invoke("test_print", { printer: buildProfile(printer) });
      const message = savedPath
        ? `PDF 已保存：${savedPath}`
        : `测试页已发送到 ${printer.name || "打印机"}，请取纸确认。`;
      showMessage("localMessage", message, "ok");
      log(message);
    } catch (error) {
      showMessage("localMessage", `测试打印失败：${error}`, "error");
      log(`测试打印失败：${error}`);
    }
  });

  $("clear").addEventListener("click", async () => {
    if (!confirm("清空本地队列与日志？尚未打印的任务会丢失。")) return;
    try {
      await invoke("clear_local_data");
      logLines.length = 0;
      $("log").textContent = "";
      showMessage("localMessage", "本地数据已清空。", "ok");
      log("本地数据已清空");
      await refreshSpool();
    } catch (error) {
      showMessage("localMessage", `清空失败：${error}`, "error");
      log(`清空失败：${error}`);
    }
  });

  $("clearLog").addEventListener("click", () => {
    logLines.length = 0;
    $("log").textContent = "";
  });
}

async function main() {
  bindEvents();
  switchTab("printers");
  if (preview) {
    document.documentElement.dataset.preview = "true";
    const banner = $("previewBanner");
    banner.hidden = false;
    if (tauriApiMissing) {
      banner.dataset.kind = "error";
      banner.textContent =
        "Tauri API 未注入（withGlobalTauri 配置异常）：当前是演示数据，无法真实打印";
      log("错误：检测到 Tauri 运行时但 window.__TAURI__ 缺失，已降级为演示模式");
    } else {
      log("界面预览模式：未检测到 Tauri 运行时，数据为演示数据");
    }
  } else {
    log("打印代理已启动");
  }

  await listen("agent-status", (event) => {
    const { status, message } = event.payload;
    applyStatus(status, message);
    log(message);
    void refreshSpool();
  });

  await listen("agent-log", (event) => log(event.payload.message));

  await loadConfig();
  await loadPrinters();
  await refreshSpool();

  // 初始状态同步：如果配置完整但尚未收到 agent 的状态事件（例如 agent 在页面
  // 加载前就已完成连接），先显示「正在连接」，后续由 agent 事件覆盖为真实状态。
  const currentStatus = $("status").textContent;
  if ($("serverUrl").value.trim() && $("token").value.trim() && currentStatus !== STATUS_TEXT.online) {
    applyStatus("offline", "正在连接云端…");
  }

  setInterval(() => void refreshSpool(), 5000);
}

await main();
