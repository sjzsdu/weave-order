# WAN-185 相机能力化 + 样品库升级截图

390×844，mock 构建（`pnpm --filter @weave-order/mobile dev`），`deviceScaleFactor: 2`。

| 文件 | 状态 |
| --- | --- |
| 01-samples-default.png | 样品 tab 默认：吸顶搜索、品类/成分/克重三行单选 chips、两列 1:1 图墙、卡片底部「用它报价」 |
| 02-samples-filtered.png | 按成分筛选：旧列表不被清空，已选条件条显示 `成分：100% 棉 ×` 与命中数；其余 chip 不消失 |
| 03-samples-no-match.png | 条件没命中：区分「库是空的」与「这个条件下没有样品」，并给「清除筛选」 |
| 04-camera-find.png | 相机 find：不再有 6 宫格，也没有运单号/备注字段，直接「拍照找样」 |
| 05-more-onsite.png | 我的 → 现场动作：相机退出 tab 后的兜底入口（六个 mode） |
| 06-camera-signature.png | 拍签收：字段跟任务走，只有运单号 + 一句说明 |
| 07-samples-error.png | 筛选请求失败：保留已加载数据，错误走 `userFacingErrorMessage`，界面无英文技术串 |
| 08-quote-from-sample.png | 点「用它报价」带 sampleId 进报价页（候选卡显示「带入的样品」） |
| 09-camera-waybill-h5.png | H5 运单号页：副标题「手工录入」、正文无「扫码」，只有「录入运单号」 |

## 复现方式

```bash
pnpm --filter @weave-order/mobile dev   # mock 模式，端口被占用时自动 +1
# 浏览器 390×844 打开 /#/pages/samples/index、/#/pages/camera/index、/#/pages/more/index
```

错误态通过临时让 mock 的 `GET /api/samples` 在带 `composition` 时抛错注入（模拟筛选请求失败），
截图后已回滚，未随提交保留。
