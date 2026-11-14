# 对象存储（S1）生产部署执行清单

> 面向执行人：照着做即可。每项都写明**在哪个环境做什么、谁有权限、漏了会怎样、怎么验证**。
> 本地联调与验收步骤见 [`local-dev-storage.md`](./local-dev-storage.md)。
> 当前实现：腾讯云 COS（S3 兼容），`apps/api/src/platform/storage.ts` 同一份代码适配
> 本地 MinIO 与生产 COS。生产/OIDC 模式使用 dev 占位 S3 凭据会**拒绝启动**。

## 0. 一句话总览

生产要落地 S1，必须同时具备四件事：**桶 + 最小权限子账号 + 上传域 CORS + 注入 `S3_*`/`MEDIA_*` 环境变量**。
`pgvector` 扩展不是 S1 的依赖（S1 只存 `object_key`），但 S3 的向量列迁移落地前必须先在
生产库启用，否则 S3 迁移会失败。

## 1. 执行项

| #   | 在哪个环境做什么                                                                                                                                                                  | 谁有权限                                 | 漏了会怎样                                                                                                                       | 验证                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | **建桶**：腾讯云 COS 控制台，地域 `ap-guangzhou`，桶名如 `weave-media-prod`，访问权限「私有读写」，开启版本控制（可选，建议开）                                                   | 云平台管理员（CAM 有 COS 建桶权限）      | `NoSuchBucket`：presign/confirm 全部 5xx/4xx，图片链路整体不可用                                                                 | `aws s3api head-bucket --bucket <桶> --endpoint-url https://cos.ap-guangzhou.myqcloud.com`（或 COS 控制台对象列表可访问） |
| 2   | **子账号与最小权限**：创建仅用于本服务的 CAM 子账号，策略只允许该桶前缀的 `PutObject` / `GetObject` / `HeadObject` / `DeleteObject`；密钥写入部署 secret 管理，不入仓库、不进日志 | 云平台管理员 + 安全负责人                | 用主账号密钥 = 单点泄漏即全账号失守；权限过大 = 一张图被删可波及全桶；权限不足 = 上传/confirm 403                                | 用子账号密钥跑第 7 节冒烟；再验证「列桶 / 删别的桶」应被拒绝                                                              |
| 3   | **CORS**：桶 CORS 允许来源为正式租户端 / 移动端 H5 域名（本地 `http://localhost:*` 只配在 dev 桶），方法 `PUT, GET, HEAD`，允许头 `Content-Type`（必要时 `*`），`Max-Age=600`     | 云平台管理员（或前端负责人提供域名清单） | 浏览器直传 PUT 被预检拦截：H5 / 小程序 WebView 上传失败；原生 App 可能不受影响，问题会被误判为"接口偶发"                         | 浏览器控制台发起 `OPTIONS` 预检返回 204/200 且含 `Access-Control-Allow-Origin`；真机 H5 上传一次                          |
| 4   | **公开读或 CDN（二选一）**：① 私有桶 + 服务端签名 URL（当前默认，`MEDIA_BASE_URL` 留空，TTL 600s）；② 公开读桶策略 + CDN 回源，`MEDIA_BASE_URL=https://cdn.<域名>`                | 云平台管理员 / 网络与安全负责人          | 配了 `MEDIA_BASE_URL` 但桶不公开 → 图片 403；不配 `MEDIA_BASE_URL` 又期望长缓存 → 每次刷新都换签名 URL，CDN 命中率归零           | 冒烟脚本第 6/7 步：`GET images[0].url` 必须 200；公开读模式再验证无签名 URL 也能取到图                                    |
| 5   | **CDN 细节（仅方案②）**：GET 缓存、上传直传域名不挂缓存、HTTPS 证书、按需 Referer 白名单；删除对象后按需刷新 URL                                                                  | 网络负责人                               | 缓存了 PUT 响应或错误页 → 上传"成功"但对象不存在；无 HTTPS → 移动端混合内容被拦                                                  | 上传后立即 GET 命中对象；带错误 Referer 应被拒；上传域名 `curl -I` 不返回 CDN 缓存头                                      |
| 6   | **注入环境变量**（部署仓库 / secret 管理，见第 2 节）；`AUTH_MODE=oidc` 时服务会校验 S3 凭据不是 dev 占位值                                                                       | 部署负责人（有生产 secret 写权限）       | 仍用 `weave-media` 占位凭据 → 进程启动即失败（这是有意的 fail-fast）；漏 `S3_FORCE_PATH_STYLE=false` → COS 上签名 URL 主机名错误 | 部署后 `GET /api/health` 200；启动日志无 S3 配置错误；用 `printenv` 确认注入的是 secret 而非仓库默认值                    |
| 7   | **冒烟验收**：生产域名跑 `API_BASE=https://api.<域名> AUTH=<生产 token> scripts/verify-media-e2e.sh`（或按第 3 节手敲）                                                           | SRE / 部署负责人                         | 没有冒烟就上线 = 又回到"已实现未验证"；问题会在客户第一次传图时暴露                                                              | 输出 `PASS … images>=1`；再在数据库确认 `sample_images.object_key` 已落库                                                 |
| 8   | **pgvector 扩展（S3 前置，不阻塞 S1）**：在生产库 `weave_order` 执行 `CREATE EXTENSION IF NOT EXISTS vector;`；托管 PG 需先在控制台扩展白名单/扩展管理里启用                      | 数据库管理员 / 具备 superuser 的 DBA     | S3 的 `vector` 列迁移直接失败，部署卡在迁移步骤；备份恢复到新实例后同样失败（扩展不在备份里）                                    | `SELECT extversion FROM pg_extension WHERE extname='vector';` 有值；`\dx vector` 可见；再从备份恢复演练一次               |

## 2. 新增环境变量（生产值）

```dotenv
# 对象存储（腾讯云 COS，S3 兼容）
S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
S3_REGION=ap-guangzhou
S3_BUCKET=weave-media-prod
S3_ACCESS_KEY_ID=<子账号 SecretId>          # 必须来自 secret 管理，不得是 weave-media
S3_SECRET_ACCESS_KEY=<子账号 SecretKey>     # 同上
S3_FORCE_PATH_STYLE=false                   # COS 必须 false；MinIO 才 true
# 公开读：填 CDN/桶域名；私有桶 + 签名 URL：留空
MEDIA_BASE_URL=https://cdn.<你的域名>
MEDIA_PRESIGN_TTL_SECONDS=600               # 签名的上传/取图有效期（秒）
MEDIA_MAX_BYTES=10485760                    # 单图上限 10MB（上传与按 URL 取图共用）
# 可选：历史域名/额外 CDN；MEDIA_BASE_URL 主机会自动并入白名单
MEDIA_ALLOWED_HOSTS=
```

注意事项：

- `MEDIA_BASE_URL` 必须是 `https`（生产取图白名单只允许 https）。填了它，`/api/samples/:id`
  返回的 `images[].url` 就是 `<MEDIA_BASE_URL>/<object_key>`，不再发签名 URL。
- 换 CDN 只改 `MEDIA_BASE_URL`，不动数据库（DB 只存 `object_key`）。这是 S1 的契约，别在迁移里存 URL。
- 生产启动门禁：`AUTH_MODE=oidc` 或 `NODE_ENV=production` 时，`S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY`
  等于 dev 占位值会直接抛错，不会静默降级。**这是预期行为，不要为了"先起来"放宽。**

## 3. 部署后冒烟（可直接粘）

```bash
API=https://api.<域名>
TOKEN='<生产个人访问凭据或测试账号 token>'

# 1) 健康
curl -fsS "$API/api/health"

# 2) 取一条样品
SID=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$API/api/samples?limit=1" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).samples[0].id))')

# 3) 一键跑完整链路（本地生成 1x1 PNG）
API_BASE="$API" AUTH="$TOKEN" SAMPLE_ID="$SID" scripts/verify-media-e2e.sh
```

没有本仓库脚本时，等价三步：

```bash
# presign
curl -fsS -X POST "$API/api/media/presign" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"mimeType\":\"image/png\",\"byteSize\":70,\"sampleId\":\"$SID\"}"
# 用返回的 uploadUrl 直传（注意按返回的 headers 带 Content-Type）
curl -fsS -X PUT "<uploadUrl>" -H 'Content-Type: image/png' --data-binary @acceptance.png
# confirm
curl -fsS -X POST "$API/api/media/confirm" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"objectKey":"<objectKey>"}'
# 复核
curl -fsS -H "Authorization: Bearer $TOKEN" "$API/api/samples/$SID"
```

成功标准：`confirm` 返回 `image.id`；`GET /api/samples/:id` 的 `images` 至少一条；
`images[0].url` 直接 GET 返回 200 且字节数与上传文件一致。

## 4. 上线顺序与回滚

**顺序**：桶与子账号 → CORS → secret 注入 → 部署 API → 冒烟 →（可选）CDN 与公开读。
一次只改一类变量，便于归因；CORS/CDN 改动与代码发布分开做。

**回滚**：

- 应用回滚：重新部署上一个镜像即可；S1 之前的版本不读取 `S3_*`，不需要删桶或改数据。
- 环境变量回滚：把 `S3_*`/`MEDIA_*` 撤回旧值属于"配置回退"，但**不要**把生产凭据改回 dev 占位值
  （会触发启动门禁）。确认回滚目标版本不依赖这些变量。
- 桶/CORS/CDN：桶删除不可逆，**不要**用删桶回滚；CORS 与 `MEDIA_BASE_URL` 可改回旧值，改完重新冒烟。
- 数据：`sample_images` 行与对象是弱一致（先传对象后 confirm）。回滚代码不会删对象；
  孤儿对象回收是 P1，不在本清单内。

## 5. CI 结论（本仓库）

**不需要改 CI，也不要改测试断言。**

依据：

- `media-upload.test.ts`（12 例）用内存 `FakeStorage`，不连任何对象存储；
- `sample-images.integration.test.ts`（5 例）只连真实 PG（`weave_app` 角色）验证级联/主图唯一/RLS；
- `.github/workflows/ci.yml` 的服务只有 `pgvector/pgvector:pg16` 与 `redis:7-alpine`，没有 MinIO，
  也没有 `S3_*`/`MEDIA_*` 环境变量；测试默认 `NODE_ENV=test`、`AUTH_MODE=dev`，不触发生产门禁。
- 实测：停掉本地 MinIO 后运行上述两个测试文件，17 例全绿（见 WAN-123 评论）。

若未来新增"真连对象存储"的测试，应使用独立 profile / 本地二进制在 CI 里拉起，
并加跳过条件，而不是把对象存储塞进所有测试的前置条件。
