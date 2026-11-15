// 浏览器里直接打开 src/index.html 时的预览桥接：只用于看小窗 UI 和走通交互，
// 不参与 Tauri 打包后的真实打印路径（真实运行时 window.__TAURI__ 一定存在）。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEMO_DISCOVERED = [
  {
    name: "Zebra ZD421",
    kind: "THERMAL",
    connection: "RAW_TCP",
    address: "192.168.1.20:9100",
    format: "ZPL",
    status: "READY",
  },
  {
    name: "HP LaserJet M404",
    kind: "A4",
    connection: "SYSTEM_DRIVER",
    address: "HP_LaserJet_M404",
    format: "ZPL",
    status: "OFFLINE",
  },
];

export function createPreviewBridge() {
  const config = { serverUrl: "", token: "", agentName: "打印代理", printers: [] };
  const spool = { pending: 2, failed: 0, printed: 12 };

  const listPrinters = () =>
    [...config.printers, ...DEMO_DISCOVERED].filter(
      (printer, index, all) =>
        all.findIndex((item) => item.name.toLowerCase() === printer.name.toLowerCase()) === index,
    );

  return async function invoke(command, args = {}) {
    await sleep(120);
    switch (command) {
      case "get_config":
        return { ...config };
      case "save_config":
        Object.assign(config, {
          serverUrl: args.serverUrl ?? "",
          token: args.token ?? "",
          agentName: args.agentName ?? "打印代理",
        });
        return null;
      case "discovered_printers":
        return {
          printers: listPrinters(),
          platform: "浏览器预览",
          tool: "demo",
          ok: true,
          message: `发现 ${listPrinters().length} 台本机打印队列（演示数据）`,
          hint: "",
        };
      case "probe_printer": {
        const printer = args.printer ?? {};
        const target = printer.address || printer.name || "打印机";
        return {
          ok: true,
          target,
          detail: "预览模式：桌面版会真实连接 9100 端口或查询系统打印队列",
        };
      }
      case "test_print":
        return null;
      case "save_printers":
        config.printers = args.printers ?? [];
        return null;
      case "spool_status":
        return { ...spool };
      case "clear_local_data":
        spool.pending = 0;
        spool.failed = 0;
        spool.printed = 0;
        return null;
      default:
        throw new Error(`预览模式不支持命令：${command}`);
    }
  };
}
