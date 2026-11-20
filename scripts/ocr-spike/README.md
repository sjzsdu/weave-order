# OCR spike 评测脚本

一次性调研脚本，不进入生产依赖。结论与数据见 [`docs/ocr-spike.md`](../../docs/ocr-spike.md)。

## 跑法

```bash
export DASHSCOPE_API_KEY=...
node scripts/ocr-spike/run.mjs \
  --manifest data/ocr-spike/manifest.json \
  --out data/ocr-spike/runs/$(date +%F)
```

参数：

- `--engine route-a|route-b`：只跑指定路线，可重复；默认两条都跑。
- `--limit N`：只跑前 N 张，用于冒烟。
- `--manifest` / `--out`：清单与输出目录。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 无 | 必填 |
| `OCR_SPIKE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点 |
| `OCR_SPIKE_ROUTE_A_MODEL` | `qwen3-vl-plus` | 多模态直抽模型 |
| `OCR_SPIKE_OCR_MODEL` | `qwen3.5-ocr` | 专用 OCR 模型 |
| `OCR_SPIKE_EXTRACT_MODEL` | `qwen-plus` | 文本字段抽取模型 |
| `OCR_SPIKE_CONCURRENCY` | `4` | 并发数 |
| `OCR_SPIKE_ATTEMPTS` | `3` | 单张重试次数 |
| `OCR_SPIKE_TIMEOUT_MS` | `120000` | 单次调用超时 |

## 清单格式

```json
{
  "dataset": "my-set",
  "samples": [
    {
      "id": "card-01",
      "kind": "card",
      "path": "data/ocr-spike/samples/card-01.jpg",
      "source": "创始人提供",
      "flags": ["glare", "handheld"],
      "mock": false,
      "gtUncertain": false,
      "groundTruth": {
        "company": "某某纺织有限公司",
        "contact": "张三",
        "title": "经理",
        "phone": "13800000000",
        "tel": "",
        "address": "",
        "business": "",
        "email": ""
      }
    }
  ]
}
```

- `kind=card` 的字段：`company/contact/title/phone/tel/address/business/email`。
- `kind=label` 的字段：`product/composition/gsm/width/lot/supplier`。
- `mock=true`（设计样卡）或 `gtUncertain=true`（真值存疑）不计入统计。
- 图片不入库：`data/ocr-spike/` 下的图片、完整 `manifest.json`、`runs/` 均被 `.gitignore` 排除；公开仓库只留 `manifest.redacted.json`。

## 输出

- `report.md`：逐字段 exact / usable / 缺失 / 错误 / 幻觉 / 时延 / token。
- `summary.json`：机器可读汇总。
- `predictions/<engine>.json`：每张图的预测、OCR 原文、token 与耗时，用于定位失败样本。

## 换成创始人样本

把 20 张名片 + 20 张面料/织厂标签放到 `data/ocr-spike/samples/`，按上面的格式补真值，重跑即可。不需要改代码。
