# 语义找样：真实文本 embedding + pgvector + HNSW（S3）

本文说明「文字找样」从 16 维哈希 stub 升级到真实语义向量后的运行方式、两种 provider 的语义差异、
以及上线前必须由 DBA 完成的一步。

## 1. 两种模式（`EMBEDDING_PROVIDER`）

| 模式                 | 向量                              | 语义   | 用途                                                                                   |
| -------------------- | --------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `local-stub`（默认） | 16 维 FNV-1a 哈希，L2 归一化      | **否** | 零 key 离线跑测试 / 演示。写入旧表 `sample_embeddings`（`real[]`），**不参与语义检索** |
| `dashscope-text-v3`  | 1024 维，通义 `text-embedding-v3` | 是     | 真实语义找样：写入 `sample_text_embeddings`（pgvector + HNSW）                         |

关键约定：

- 哈希向量与「相似」没有任何关系。`local-stub` 下 `searchBySpec` 只跑 ILIKE，
  不会把哈希分数贴 `matchedOn: ["semantic"]` 返回。
- 真实模型失败（超时 / 429 / 5xx）时**直接抛错**，接口返回 5xx，绝不回退哈希。
  4xx（除 429）不重试（配置/输入错误，重试没有意义）。
- 单次最多 10 条文本（通义限制），provider 内部分片；重试 3 次指数退避（250ms → 500ms）。

## 2. 环境变量

见 `.env.example` 的 embedding 段。要点：

```bash
EMBEDDING_PROVIDER=dashscope-text-v3
EMBEDDING_MODEL=text-embedding-v3        # 默认
EMBEDDING_DIMENSION=1024                 # 必须与 vector(1024) 列一致
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=...                    # 缺省回落到 DASHSCOPE_API_KEY
EMBEDDING_TIMEOUT_MS=20000
EMBEDDING_MAX_ATTEMPTS=3
SEARCH_SEMANTIC_MIN_SCORE=0.5            # 实测无关文本 cosine 基线 0.37–0.49
```

为什么直连 DashScope 而不是 LiteLLM 网关：本地网关只收录了对话模型，embedding 与对话的
超时/重试/计费语义不同；直连可以把 base URL / key 都留在 env，不要求改网关配置并重启。
以后网关收录该模型时，只需把 `EMBEDDING_BASE_URL` 改成 `http://localhost:4000/v1`。

## 3. 数据库

新增表 `sample_text_embeddings`（迁移 `0014_sample_text_embeddings`）：

- `embedding vector(1024)`、唯一键 `(sample_id, model)`、`content_hash`（生成向量的原文 sha256）。
- HNSW：`USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`。
- RLS 与 `samples` / `sample_images` 完全一致（`tenant_isolation`，`FORCE ROW LEVEL SECURITY`）。

旧表 `sample_embeddings`（`real[]`）**不删除、不再写真实数据**，只保留 `local-stub` 的以图搜图兼容路径；
S4 会用多模态模型与独立图像向量表替换它。

### 生产必须由 DBA 执行

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

非 superuser 角色执行迁移会报 `permission denied to create extension "vector"`；
`pnpm db:migrate` 会把这条错误翻译成明确的「请 DBA 执行 `CREATE EXTENSION vector`」提示。
镜像 `pgvector/pgvector:pg16` 已内置扩展，本地无需额外操作。

## 4. 索引维护

- **单条创建/编辑**：同一请求内同步写入向量。改名 / 改成分 / 改品类 / 改克重才重算，
  改价格或图片不会调用模型（`contentHash` 未变直接跳过）。
- **批量导入**：事务提交后统一重算；失败不回滚导入，但写 `SAMPLE_INDEX_FAILED` 审计。
- **后台 / CLI 重算**：

```bash
pnpm --filter @weave-order/api reindex:samples
pnpm --filter @weave-order/api reindex:samples -- --tenant=<uuid>
```

有失败行时退出码为 1，便于定时任务告警。

## 5. 检索行为

`searchBySpec` 保留原有 ILIKE 语义，并在查询满足「长度 ≥ 8 / 含空格 / 含英文」且 provider 具备语义时，
追加一次向量检索：

1. ILIKE 命中的结果排在前面（`score` = 命中字段占比，`matchedOn` 为字段名）；
2. 向量结果补足未被 ILIKE 命中的样品（`matchedOn: ["semantic"]`，`score` = 原始 cosine 相似度）；
3. 低于 `SEARCH_SEMANTIC_MIN_SCORE` 的结果直接丢弃，不做归一化或映射。

## 6. 实测结果（本机，2026-11-14）

- 真实模型：`POST https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings`
  （`model=text-embedding-v3`, `dimensions=1024`）返回 1024 维向量；单批上限 10 条已实测（11 条会 400）。
- 同义/中英对照 5 组（含 5 个干扰样品）：**5/5 组 top-3 命中**，见
  `apps/api/test/s3-semantic.integration.test.ts`（`DASHSCOPE_API_KEY` 存在时运行）。
- 1000 条样品：向量查询（含 JOIN）p95 ≈ 15ms；此规模下 planner 认为 Seq Scan + top-N sort 更便宜，
  会**主动选择顺序扫描**（成本模型判断正确）。
- 5000 条样品：planner 自然选择 HNSW（`EXPLAIN` 含 `sample_text_embeddings_embedding_hnsw_idx`），
  p95 ≈ 2ms。也就是说 50ms 目标在 1000 条时已满足，HNSW 的收益从约 5k 行开始体现。

> 如果需要在 1000 行的小库上强制验证索引可服务性，可在会话里 `SET LOCAL enable_seqscan = off`；
> 不要把它写进生产查询——那会让小库变慢。
