# 织序打印代理（E5）

Tauri 2 + Rust 的本地常驻小程序：接住云端打印队列，把 A4 单证交给系统驱动、把箱唛标签走 RAW TCP（ZPL/TSPL）。目标是「装一次，所有打印机都能用」，并且**只打印、不读业务数据**。

## 职责边界

- **WSS 出站**：连接 `wss://<api>/api/print/agent/ws?token=…`，不开放任何入站端口。
- **最小权限**：token 由打印中心注册产生，作用域 `print`；服务端中间件会拒绝它访问任何非 `/api/print/agent/*` 路由（包括公开目录）。
- **本地 spool**：SQLite 保存待打任务，`idempotency_key`（服务端任务 ID）去重；载荷 ≤24h，超时自动清理。
- **本地校准**：每台打印机可叠加偏移/浓度（ZPL `^LH`/`^MD`，TSPL `SET DENSITY`），不改云端模板。
- **离线补打**：断网时任务留在本地，联网后按序补传结果；打印成功但回执失败时只重传回执，不重复出纸。
- **自动更新 / 自启 / 托盘**：`tauri-plugin-updater` + `tauri-plugin-autostart`，签名包灰度与回滚由发布端控制。

## 目录

```
src/                     WebView 控制台（原生 HTML/JS：配置 / 打印机 / 本地数据）
src-tauri/src/config.rs  配置与 WSS 地址推导
src-tauri/src/spool.rs   SQLite 本地队列（24h 清理、幂等、回执重传）
src-tauri/src/printers.rs 系统打印队列发现（lpstat / Get-Printer）
src-tauri/src/printer.rs  A4 PDF 打印、RAW TCP ZPL/TSPL、本地校准、测试标签
src-tauri/src/agent.rs   WSS 长连接、wake → claim、本地执行与回执
src-tauri/src/commands.rs Tauri IPC：保存配置/打印机、spool 状态、清空
```

## 本地开发

前置：Node 20+、pnpm 10+、Rust 1.77+、Tauri 2 系统依赖（Windows 需要 WebView2；Linux 需要 webkit2gtk；macOS 需要 Xcode CLT）。

```bash
pnpm install
pnpm --filter @weave-order/print-agent dev
```

首次启动：

1. API 跑起来（`pnpm --filter @weave-order/api dev`）。
2. 在织序桌面「打印 → 设备 → 注册打印代理」生成 token（只显示一次）。
3. 代理里填 `http://localhost:3000` + token，保存。
4. 点「重新发现」，热敏打印机把地址改成 `192.168.x.x:9100`、格式选 ZPL/TSPL；A4 保持系统队列名。
5. 「保存打印机 profile」→ 心跳上报 → 云端的打印任务会自动落到本地。
6. 点「打印测试标签」确认对齐、浓度、二维码可扫。

## 打印路径

| 单据                     | 载荷            | 路径                                                      |
| ------------------------ | --------------- | --------------------------------------------------------- |
| 拣货单 / 发货单 / 装箱单 | base64 PDF      | `lp -d <queue>`（Unix）或 SumatraPDF / PrintTo（Windows） |
| 箱唛 / 测试标签          | ZPL / TSPL 文本 | RAW TCP `host:9100`；Unix 也可 `lp -o raw`                |

Windows 热敏打印机**必须**配置 RAW TCP（`IP:9100`）：Windows 打印队列不接受直接写 ZPL 字节，走驱动会变成乱码。

## 自动更新与签名

1. `pnpm --filter @weave-order/print-agent exec tauri signer generate -w ~/.tauri/weave.key`
2. 把公钥填进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
3. 把私钥内容存成仓库密钥 `TAURI_SIGNING_PRIVATE_KEY`，密码存 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
4. 把 `latest.json` 与安装包发布到 `https://print.weaveorder.cn/agent/`（或改 endpoints）。
5. 灰度：先让一台代理升级试打，再放量；回滚只换 `latest.json` 指向旧版本。

## 发版：多平台安装包

`.github/workflows/print-client.yml` 负责打包与发布，触发方式：

```bash
# 推 tag 即发布；只有 apps/print-agent/** 相对上一个 tag 有改动才会真的打包
git tag -a v0.2.0 -m "print agent v0.2.0" && git push origin v0.2.0
```

- 平台矩阵：Windows x64、macOS x64 + arm64、Linux x64 + arm64（`ubuntu-24.04-arm` 仅公开仓库可用）。
- 产物进 GitHub Release（资产名 `weave-print-agent_<版本>_<平台>_<架构>.<格式>`），Linux 额外出 `.deb`/`.rpm`/`.AppImage`，
  macOS 出 `.dmg`，Windows 出 `.msi` 与 `-setup.exe`。
- 版本号以 tag 为准：`v0.2.0` → 客户端版本 `0.2.0`，同时写进安装包名与 `latest.json`。
- 自动更新产物：仓库密钥 `TAURI_SIGNING_PRIVATE_KEY` 存在、且 `plugins.updater.pubkey` 已替换成真实公钥时才生成
  `latest.json`；否则只出安装包并在构建摘要里告警（客户端不会自动升级）。
- 代码签名可选：配置 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`（macOS，未配则用 ad-hoc 签名）、
  `TAURI_WINDOWS_CERTIFICATE` / `TAURI_WINDOWS_CERTIFICATE_PASSWORD`（Windows，未配则安装包不带签名，可能被杀毒软件拦截）。
- 手动触发（Actions → print-client → Run workflow）可以不带 tag 只出包（产物落在 workflow artifacts），
  或带 tag 补发；`updater` 可选 `auto` / `signed` / `none`。
- 发布前默认等该提交的 `ci` 跑绿（与镜像流水线同一道质量门），需要跳过时手动触发并关掉 `require_ci`。

## 安全与隐私

- 本地只存任务载荷（打印指令）与任务 ID，不存客户列表/订单列表。
- 日志只记录任务短 ID 和结果，不记录载荷内容；「一键清空」删除 spool 并 VACUUM。
- token 失效（轮换/禁用代理）后 WSS 与 HTTP 回执都会 401，代理不再领取任务。

## 验证状态

CI 的 `print-agent` 作业（`.github/workflows/ci.yml`）会安装 Tauri 2 的 Linux 系统依赖，跑
`cargo check --all-targets --locked` 与 `cargo test --lib --locked`：Rust 编译失败或单元测试失败都会让 PR 变红。
`Cargo.lock` 已提交，依赖漂移同样会变红。`tauri build` 打安装包由 `.github/workflows/print-client.yml`
在推 tag 时执行（见上文「发版：多平台安装包」）。

单元测试覆盖纯逻辑：配置读写与 WSS 地址推导（`config.rs`）、ZPL/TSPL 校准注入（`printer.rs`）、
spool 幂等 / 顺序 / 回执 / 清空（`spool.rs`）。涉及真实打印机的路径（`lp`、RAW TCP）不做自动化，
首次部署按上文「打印路径」手测。

服务端契约、WSS 协议与打印数据流由 `apps/api/test/print.e2e.test.ts` 覆盖。
