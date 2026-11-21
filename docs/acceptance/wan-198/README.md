# WAN-198 样卡验收证据

本目录是 P0b 的机器可复现证据；**实物打印与手机对纸扫码仍需人工完成**，缺口单列在文末。

## 1. 预览与打印产物对照（验收 1）

`a4-preview-vs-artifact.png`：左 = 报价页「版式预览」（HTML 模板），右 = 入队时交给打印代理的同一份 PDF 栅格化。

样本故意用接近上限的长样品名（24 字）与带 `±` 的克重，验证不截断、不错位、不缺字形。

## 2. 80×50mm 标签（验收 2 的产物部分）

`label-80x50.png`：ZPL 在 203dpi、80×50mm 画布上的渲染（label-01 与 label-40）。`labels-40-sheet.png`：连续 40 张总览。

## 3. 连续 40 张二维码解码（验收 5 的机器部分）

一键复现（生成 → 渲染 → 解码 → 逐条比对）：

```bash
PUBLIC_APP_URL=https://quote.weave.example.com pnpm --filter @weave-order/api verify:sample-card
pip install opencv-python-headless requests
python3 apps/api/scripts/verify-sample-card-qr.py apps/api/.artifacts/sample-card
```

- 生成：`verify:sample-card` 产出 40 份不同编号的 ZPL 与 `labels.json`（预期 URL）。
- 渲染：`verify-sample-card-qr.py` 调 Labelary，以 **8 dots/mm（203dpi）、80×50mm** 输出位图。
- 解码：OpenCV `QRCodeDetector`，先原尺寸、再放大 2 倍（部分图案原尺寸失败、放大即可，与手机取景同理），与预期 URL 逐字节比对。

本目录提交了完整数据，未做截断：

- `labels.json`：40 张卡片的编号与预期二维码 URL。
- `decode-results.json`：逐张解码结果（`decoded` / `expected` / `ok`）。
- `decode-summary.md`：40 条汇总表。

**结果：40/40 可解码且逐字节一致。** 这不是手机对纸扫码：它证明打印栅格下二维码完整、未越界、可解码；实物扫码仍需真机完成。

## 4. Token 与编号的边界

- 二维码 token 是紧凑二进制 `[版本][tenant 16B][codeLen 1B][code UTF-8][HMAC-SHA256 12B]`，base64url。
  原 JSON+完整签名版本约 120 字符，在 400 点高的标签上把二维码顶出边界（实测 0/40 可解码）。
- 因此样品编号同时受 **32 字符**（版面宽度）与 **32 字节**（token 容量）约束；中文按 3 字节计。
  超限时返回 `PRINT_FIELD_OVERFLOW`（400），不再因 token 层抛裸 `Error` 变成 500。

## 5. 仍未完成的实物项（验收 2、5 的人工部分）

- A4 打印机与 80×50 热敏机各实际出纸一次，拍纸面照片，记录设备型号与纸张型号。
- 连续打印 40 张，手机逐张扫码，记录 40/40 与失败原因。
- ZPL 设备需装 CJK 字库（否则中文样品名不打印，见 `label-80x50.png`）；TSPL/TSC 设备用内置 `TSS` 中文字体。
