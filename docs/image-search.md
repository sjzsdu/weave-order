# 以图找样：多模态图像向量 + pgvector（S4）

本文说明「拍照找样」的真实实现：模型怎么选、钱花在哪、阈值为什么是这两个数、
以及**换 provider 到底要做什么**（这是最容易被误解的一点）。

配套：文本检索见 [`semantic-search.md`](./semantic-search.md)。两套向量、两张表、两组阈值，刻意不共用。

## 1. 两种模式（`IMAGE_EMBEDDING_PROVIDER`）

| 模式                | 向量                               | 视觉语义 | 用途                                                   |
| ------------------- | ---------------------------------- | -------- | ------------------------------------------------------ |
| `local-stub`（默认） | 16 维 FNV-1a 哈希，L2 归一化       | **否**   | 零 key 离线跑测试 / 演示；响应标 `semantic: false`      |
| `dashscope-qwen3-vl` | 1024 维（可配），`qwen3-vl-embedding` | 是       | 真实图搜图：写入 `sample_image_embeddings`（pgvector）  |

- 图向量与文向量**同空间**（同一多模态模型），但和图-图分数不是同一分布，阈值必须分开配。
- 模型不可用时**直接报错**；只有显式开启 `CAPTION_FALLBACK=true` 才退回「视觉模型描述 → 文本检索」，
  且响应标 `mode: "caption"`，前端文案不同。绝不静默混用两条链路。

## 2. 为什么是 `qwen3-vl-embedding`

2026-11-14 用真实 key 实测（同款异角度 / 易混异款 5 图矩阵，分离度 = 同款余弦 − 最易混异款余弦）：

| 模型                        | 维度              | 同款异角度 | 最易混异款 | 分离度  | 图片单价（元/千 token） |
| --------------------------- | ----------------- | ---------- | ---------- | ------- | ----------------------- |
| **qwen3-vl-embedding**      | 2560（可设 1024） | 0.956      | 0.606      | **0.350** | 0.0018                  |
| tongyi-embedding-vision-plus | 1152            | 0.885      | 0.690      | 0.195   | 0.0005                  |
| tongyi-embedding-vision-flash | 768            | 0.881      | 0.634      | 0.247   | 0.00015                 |
| multimodal-embedding-v1     | 1024              | 0.897      | 0.713      | 0.184   | 0.0009                  |

- `qwen3-vl-embedding` 是唯一跨模态也对得上的（图 → 正确描述 0.53~0.57，其余 ≤0.34）。
- `multimodal-embedding-v1` 被排除：图片 batch 只允许 1 张/请求（1 万张 = 1 万次 HTTP），分离度最差。
- `jina-clip-v2` 不可用：国内机房访问 `api.jina.ai` 超时。

## 3. 钱花在哪

图片按 token 计费，token 数随分辨率走（`qwen3-vl-embedding`）：

| 送图尺寸        | 图片 token | 折算      |
| --------------- | ---------- | --------- |
| 256×256         | 64         | 0.115 元/千张 |
| 512×512         | 256        | 0.46 元/千张  |
| 1024×1024       | 1024       | 1.84 元/千张  |
| 手机原图（1536+） | 1225（封顶） | 2.2 元/千张   |

**服务端在送模型前会把图缩到长边 512px**（`IMAGE_EMBEDDING_MAX_EDGE`，索引与查询共用同一条预处理），
所以实际落在 0.46 元/千张这一档，而不是手机原图档。客户端压缩（长边 ≤1600px / ≤1MB）是为存储和展示，
不是为 embedding —— 两者目标不同。
按 1 万张图、每天 1000 次查询算，月成本是个位数人民币。
**不要为省钱做架构妥协**（自训模型、拿 flash 顶主路径都不划算）。

## 4. 阈值

| 常量                             | 默认 | 依据                                                         |
| -------------------------------- | ---- | ------------------------------------------------------------ |
| `SEARCH_IMAGE_MIN_SIMILARITY`      | 0.75 | 同款异角度 0.89~0.96，最易混异款（浅蓝牛仔 vs 灰针织）0.61~0.69 |
| `SEARCH_IMAGE_TEXT_MIN_SIMILARITY` | 0.35 | 文-图正确配对 0.35~0.57；套 0.75 会让 caption 兜底永远返回空   |

`minSimilarity` 由调用方显式传值时以调用方为准（T-001 契约默认 0.75）。旧值 0.55 会把不同面料放进来。

## 5. 表与索引

```sql
sample_image_embeddings(
  id uuid pk, tenant_id uuid, sample_id uuid, image_id uuid,
  model varchar(64), dimension int,
  embedding vector,          -- 刻意不声明维度
  created_at timestamptz
)
unique (image_id, model)     -- 同一张图同一模型只算一次
```

`embedding` 不定维，索引是**每模型一条 partial 表达式索引**：

```sql
create index sample_image_embeddings_hnsw_dashscope_qwen3_vl_embedding_1024
  on sample_image_embeddings
  using hnsw ((embedding::vector(1024)) vector_cosine_ops)
  with (m=16, ef_construction=64)
  where model = 'dashscope-qwen3-vl-embedding';
```

查询必须带 `model = ?` 且用同样的 `::vector(N)` 表达式，planner 才会命中该索引（实测 1000 张 p95 ≈ 1ms）。

索引名带**模型 + 维度**：只改 `IMAGE_EMBEDDING_DIMENSION` 而不改模型时，
如果索引名只由模型派生，`CREATE INDEX IF NOT EXISTS` 会静默跳过、留下一条错维度的索引。
`ensureHnswIndex()` 额外会核对已存在索引的维度，不一致直接报错。

## 6. 换 provider 要做什么

**向量不能跨模型比较**，所以换模型 = 全量重算，这不是配置开关。但因为数据都在自己手上，代价很小：

```bash
# 1. 改 env：IMAGE_EMBEDDING_MODEL / IMAGE_EMBEDDING_DIMENSION / IMAGE_EMBEDDING_PROVIDER
# 2. 建该模型的 partial HNSW 索引并回填（1 万张约 1 元、几分钟）
pnpm --filter @weave-order/api reindex:images --ensure-index
# 3. 重启 API
```

- 旧模型的行**保留**，回滚只需把 env 改回去（配套索引也还在）。
- 真正会锁死的是「把向量托管给厂商」（Pinecone / 厂商知识库）——向量取不回来、也没法本地重建。
  所以本方案坚持 pgvector + 自持原图。
- 极端兜底：自建 `chinese-clip` / `open_clip`，接入方式只是「再一个 model 值」。

## 7. 索引时机（异步，不阻塞上传）

```
挂图 confirm / 建改样品
   → 写 sample_images（index_status = pending）
   → 入队（进程内 ImageIndexWorker，并发 2）
   → 后台：withTenantSession(tenant) → 缩图 → embedding → 写向量 + ready
```

- HTTP 响应不等模型：上传/建样品立即返回，图状态是 `pending`，图墙显示「检索中」。
- 进程崩了不丢任务：行还是 `pending`，该租户下次找样会触发一次补漏（每租户 60s 节流）。
- 没有上 Redis 队列：数据库本身就是队列（`index_status`），省一个 broker 与多实例抢锁；
  需要「跨实例秒级派发」时再上 Redis，接口不用改。
- CLI / 单测没有 worker，退回同步索引，时序确定。

## 8. 索引状态

- `sample_images.index_status`：`pending | ready | failed`，`index_error` 存最近一次失败原因。
- **失败会自动重试**：`failed` 的行会出现在下一次补漏 / 建改样品 / `reindex:images` 的候选里，
  不会因为一次瞬时错误就永远不进检索。
- 找样响应带 `indexing`（本租户还有多少张图没索引）：前端提示「结果可能不全」。
- 从 S3 升级上来时，历史图片都是 `pending`，跑一次 `reindex:images` 补齐。

## 9. 上线清单

1. 迁移 `0014_steady_nemesis.sql`（建表 + `index_status` 列 + partial HNSW + RLS）。
2. env：`IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl`、`IMAGE_EMBEDDING_API_KEY`（或 `DASHSCOPE_API_KEY`）；
   `IMAGE_EMBEDDING_MAX_EDGE` 默认 512。若开 `CAPTION_FALLBACK=true`，文本 embedding 必须是真实模型
   （`EMBEDDING_PROVIDER=dashscope-text-v3`），否则启动即报错 —— 哈希向量做文本检索没有意义。
3. `pnpm --filter @weave-order/api reindex:images --ensure-index` 回填历史图片。
4. 真机验收：拍照 → 上传 → 看到带缩略图的 top-5（含命中图与相似度）。
