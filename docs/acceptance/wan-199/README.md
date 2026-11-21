# WAN-199 模板自定义编辑器 · 验收截图

真机 E2E：Playwright + dev 租户（`dev:demo:demo`）+ 真实 API（本机 `tsx src/main.ts`），
真实已确认报价数据。全程浏览器控制台零报错。

| 文件 | 场景 |
| --- | --- |
| `01-templates-list.png` | 模板列表：复制系统样卡入口 + 各模板来源/版面/版本 |
| `02-editor-draft.png` | 复制后的草稿：9 行默认版式、二维码右侧 30mm、版本列表为空 |
| `03-editor-unsaved.png` | 改版式后：隐藏「样品名称」、品牌字号改 22，顶部出现「未保存」 |
| `05-published.png` | 发布 v1：当前 v1、已发布、版本列表显示发布时间与打印次数 |
| `06-preview.png` | 真实报价数据预览：隐藏字段不出现、二维码在右、字段清单逐行展示 |
| `07-test-print.png` | 试打一张：入队成功，提示「不计入正式打印记录」 |
| `08-two-versions.png` | 连发 v2 后：v2 当前使用、v1 可切回 |
| `09-rolled-back.png` | 切回 v1：v1 当前使用、v2 可切回，编辑器回到 v1 版式 |
| `10-mobile-390.png` | 390px 宽度：每行控件纵向堆叠，操作不被裁切 |

复现方式：本机 `docker compose up -d` + `pnpm db:migrate` + `pnpm --filter @weave-order/api demo`，
API `AUTH_MODE=dev PORT=32xx`，Web `next start` 指向该 API，cookie `weave_token=dev:demo:demo`。
