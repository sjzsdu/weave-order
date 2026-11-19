# WAN-184 报价闭环六状态截图

390×844（10-narrow-320 为 320×844），mock 构建，`deviceScaleFactor: 2`。

| 文件 | 状态 |
| --- | --- |
| 01-input.png | 默认：客户未选、三示例 chip、剪贴板/语音入口 |
| 02-candidates.png | 候选：听懂了 chips + 横向卡片 + 内核建议单价 |
| 03-guard-needs-customer.png | 未选客户点候选：拦住 + 打开客户选择（最近 5 个） |
| 04-parsing.png | 加载：解析中、找样未回 |
| 05-search-error.png | 错误：找样服务不可用，原话保留可重试 |
| 06-draft.png | 草稿一屏 + 按权限的主按钮 |
| 07-shared.png | 已批准：原地生成链接 + 复制/转发 |
| 08-no-approve.png | 无 quote.approve：主按钮「提交审批」 |
| 09-clipboard-denied.png | 剪贴板无权限：可读提示 |
| 10-narrow-320.png | 320 宽 + 超长原话，无横向滚动 |

错误态与无权限态通过临时修改 mock 注入（找样失败、移除 quote.approve），未提交这些改动。
