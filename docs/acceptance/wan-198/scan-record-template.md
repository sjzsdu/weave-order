# 样卡实物验收记录（模板）

填完把本文件作为评论附件或直接贴到 issue 即可。两项都完成后，把下面的「结论」改成 PASS。

## A4 打印（验收 2A）

- 打印机型号：
- 纸张：A4 / 克重：
- 使用的文件：`docs/acceptance/wan-198/a4-preview-vs-artifact.png` 右侧那张（= 入队 PDF）
- 纸面照片：1 张（与 `a4-preview-vs-artifact.png` 左侧预览并排更好）
- 检查点：样品编号 / 名称 / 成分 / 克重 / 业务员姓名电话 / 二维码 与预览一致，无截断

结论：PASS / FAIL（失败写原因）

## 80×50 标签打印（验收 2B）

- 打印机型号：
- 纸张/标签型号：
- 文件二选一：
  - 真机路径：`apps/api/.artifacts/sample-card/labels/*.zpl`（`verify:sample-card` 生成）经打印代理/驱动下发；
  - 通用路径：`docs/acceptance/wan-198/print-kit-40-labels-a4.pdf`（A4 纸 1:1 打印后裁切，QR 与真机内容一致，仅用于扫码验证）
- 纸面照片：1 张
- 检查点：二维码可扫；ZPL 机型确认已装 CJK 字库（否则中文名不打印）

结论：PASS / FAIL（失败写原因）

## 40 张连续扫码（验收 5）

- 设备与纸张型号：
- 打印件：`print-kit-40-labels-a4.pdf` 5 页共 40 张
- 扫码方式：手机系统相机 / 扫码 App
- 记录：

| # | 样品编号 | 扫出内容 | 可读 |
| --- | --- | --- | --- |
| 1 | FM-001-B | 样品编号 + 业务员电话页 | ✅ |
| … | … | … | … |

- 合计：__/40 可读
- 失败张数与原因（若无可写「无」）：

结论：PASS / FAIL

## 风险确认

- ZPL 路径依赖打印机 CJK 字库；未装字库时中文样品名不打印（编号/电话/二维码不受影响）。
- 二维码指向 `PUBLIC_APP_URL`，生产必须是公网可达地址（`verify:sample-card` 会对 localhost 告警）。
