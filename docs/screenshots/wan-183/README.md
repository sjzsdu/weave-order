# WAN-183 移动端 IA 改造截图

390×844（`deviceScaleFactor: 2`），mock 构建（`pnpm --filter @weave-order/mobile build:demo`），
用 Playwright 在静态服务上走真实交互后截图。

| 文件 | 状态 |
| --- | --- |
| 01-today.png | 待办首屏：问候 → 结论 → 开报价 → 第一张待批卡（改价/批准）→ 小织在跟 → 折叠动态 |
| 02-today-expanded.png | 动态展开：小织今天做的 3 件事（滚动到底） |
| 03-today-undo.png | 待办内联批准：卡片不离开页面，5 秒撤销条落在 tabbar 之上 |
| 04-approvals.png | 审批页（不再占 tab）：导航栏 + 三行卡片 + 驳回/客户/改价/批准 |
| 05-quote.png | 开报价 tab：直接进入粘贴原话（页面内部是 WAN-184 的单屏流程，只是去掉了二级页导航栏） |
| 06-samples.png | 样品 tab：图墙可用（原先 mock 缺分页字段会直接进错误态） |
| 07-more.png | 我的：身份切换、离线队列、安装与隐私；样品入口已移除 |
| 08-camera.png | 相机（二级页）：带返回，从待办/样品按 mode 打开 |
| 09-offline-queued.png | 离线批准：模拟断网 → 批准 → 卡片移除并提示「已存本地，联网后提交」，待办出现「1 条改动已存本地」 |
| 10-quote-edit-from-today.png | 待办「改价」→ 报价 tab 直接进入报价草稿（入口参数经 routes 暂存传递，草稿屏复用 WAN-184 的实现） |

补充验证（脚本断言，未截图）：

- tab 依次为 待办 / 客户 / 开报价 / 样品 / 我的；审批与相机不在 tab，深链与入口可达。
- 点 tabbar、待办 CTA、查看全部、返回、客户行「快速报价」均按预期跳转，无页面报错。
- 8 个页面在 390 宽下均无横向滚动。
