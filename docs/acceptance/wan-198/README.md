# WAN-198 样卡验收证据

本目录是 P0b 的机器可复现证据；**实物打印与手机对纸扫码仍需人工完成**，缺口单列在文末。

## 1. 预览与打印产物对照（验收 1）

`a4-preview-vs-artifact.png`：左 = 报价页「版式预览」（HTML 模板），右 = 入队时交给打印代理的同一份 PDF 栅格化。

样本故意用接近上限的长样品名（24 字）与带 `±` 的克重，验证不截断、不错位、不缺字形。

## 2. 80×50mm 标签（验收 2 的产物部分）

`label-80x50.png`：ZPL 在 203dpi、80×50mm 画布上的渲染。QR 由打印机指令生成，逐张解码见下。

`labels-40-sheet.png`：连续 40 张标签的总览。

## 3. 连续 40 张二维码解码（验收 5 的机器部分）

方法：`verify:sample-card` 生成 40 张不同样品编号的 ZPL → Labelary 以 **8 dots/mm（203dpi）、80×50mm** 渲染成位图 → OpenCV `QRCodeDetector` 解码并与预期 URL 逐字节比对。

这不是手机对纸扫码：它证明的是「打印栅格下二维码完整、未越界、可解码」。实物扫码仍需手机对纸完成。

| #   | 样品编号 | 解码结果                                          | 一致 |
| --- | -------- | ------------------------------------------------- | ---- |
| 1   | FM-001-B | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 2   | FM-002-C | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 3   | FM-003-D | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 4   | FM-004-E | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 5   | FM-005-F | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 6   | FM-006-G | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 7   | FM-007-H | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 8   | FM-008-I | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 9   | FM-009-J | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 10  | FM-010-K | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 11  | FM-011-L | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 12  | FM-012-M | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 13  | FM-013-N | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 14  | FM-014-O | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 15  | FM-015-P | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 16  | FM-016-Q | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 17  | FM-017-R | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 18  | FM-018-S | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 19  | FM-019-T | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 20  | FM-020-U | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 21  | FM-021-V | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 22  | FM-022-W | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 23  | FM-023-X | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 24  | FM-024-Y | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 25  | FM-025-Z | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 26  | FM-026-A | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 27  | FM-027-B | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 28  | FM-028-C | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 29  | FM-029-D | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 30  | FM-030-E | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 31  | FM-031-F | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 32  | FM-032-G | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 33  | FM-033-H | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 34  | FM-034-I | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 35  | FM-035-J | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 36  | FM-036-K | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 37  | FM-037-L | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 38  | FM-038-M | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 39  | FM-039-N | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |
| 40  | FM-040-O | https://quote.weave.example.com/s/sample/AQAAAAA… | ✅   |

**合计 40/40 可解码且与预期一致。**

## 4. 仍未完成的实物项（验收 2、5 的人工部分）

- A4 打印机与 80×50 热敏机各实际出纸一次，拍纸面照片，记录设备型号与纸张型号。
- 连续打印 40 张，手机逐张扫码，记录 40/40 与失败原因。
- ZPL 设备需装 CJK 字库（否则中文样品名不会打印，见 `label-80x50.png`）；TSPL/TSC 设备用内置 `TSS` 中文字体。
