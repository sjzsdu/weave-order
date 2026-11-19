# 生产上线 runbook：对象存储 + pgvector + 向量回填（S1 / S3 / S4）

> 面向执行人（DBA / 云平台管理员 / 安全负责人 / 部署负责人 / SRE）。
> 本仓库不包含 deploy 仓库；本文只写「在哪个系统做什么、用什么命令、怎么判定成功、失败/回滚怎么办」。
> 本地联调见 [`local-dev-storage.md`](./local-dev-storage.md)；embedding 选型与阈值依据见
> [`semantic-search.md`](./semantic-search.md)、[`image-search.md`](./image-search.md)。

**一句话**：S1 图片链路要「桶 + 最小权限子账号 + CORS + env」；S3/S4 向量检索要「pgvector 扩展 + 迁移 + 回填」。
扩展必须先于迁移，回填必须在发布之后，两者都不改变业务代码。

**占位符对照（命令里统一用变量，不要逐条猜）**：

| 占位符         | 含义 / 谁提供                      | 示例                                    |
| -------------- | ---------------------------------- | --------------------------------------- |
| `<APPID>`      | 腾讯云账号 APPID，云平台管理员提供 | `1250000000`                            |
| `<pg-host>`    | 生产 PG 内网/外网地址，DBA 提供    | `pg-weave.internal`                     |
| `<bucket>`     | 带 APPID 的桶名                    | `weave-media-prod-1250000000`           |
| `<api-domain>` | 租户端 API 域名                    | `weave-api.wnbgj.com`（以实际部署为准） |
| `<web-domain>` | 租户端 Web 域名（CORS 来源）       | `weave.wnbgj.com`                       |
| `<quote-域名>` | 客户报价页域名，前端负责人提供     | `quote.weaveorder.cn`                   |
| `<租户端域名>` | 开通链接 / CLI 登录确认页域名      | `weave.wnbgj.com`                       |

**开工前 60 秒自检**（缺工具先装，不要做到一半才发现）：

```bash
command -v psql aws curl node openssl   # 任一缺失先补
# 没有 aws CLI 时：桶验证可用 coscli（`coscli cp` + `coscli ls`）或 COS 控制台
# 上传/下载探针对象完成同样的「桶可读写」判定；pgvector 仍必须用 psql 或控制台 SQL 窗口
```

## 0. 主干：执行顺序与每一步的通过标准

1. **冻结信息**：填好下面这张表，失败时按它回滚。

   | 项                            | 值  |
   | ----------------------------- | --- |
   | 上线日期 / 窗口               |     |
   | 当前线上 `WEAVE_TAG`          |     |
   | 数据库实例 / 库名             |     |
   | 最近可恢复备份 / 时间         |     |
   | 各步执行人（DBA/云/部署/SRE） |     |
   | 每步完成时间                  |     |

2. **DBA：启用 pgvector**（先于任何迁移）：
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   SELECT extversion FROM pg_extension WHERE extname = 'vector';   -- 必须有值
   ```
   非 superuser 报 `permission denied to create extension "vector"` 就停在这里找 DBA，不要改迁移。
3. **云平台：建桶 + 管理员验证**：COS `ap-guangzhou`，私有读写，开版本控制；桶名带 APPID（如 `weave-media-prod-1250000000`）。
   建完用**管理员凭据**（控制台或 `coscli`）上传探针对象 `tenant/probe/probe.txt` 并 HEAD 到；
   这一步只证明桶可读写，不验证最小权限。
4. **云平台：CAM 子账号 + 最小权限**：只授权该桶 `tenant/*` 前缀的 `PutObject/GetObject/HeadObject/DeleteObject`。
   子账号密钥进 secret 管理；禁止把主账号密钥写进任何 env。
   通过标准：用**子账号** `head-object` 探针 200；`aws s3 ls`（列桶）与访问别的桶均 403
   （不是 `head-bucket`，最小权限不含列桶）。
5. **云平台：CORS**：来源填正式 Web/移动端 H5 域名；方法 `PUT, GET, HEAD`；头 `Content-Type`；`Max-Age=600`。
   按 3.3 节的 `curl` 或浏览器 Network 面板验一次 `OPTIONS` 预检，必须返回 204/200 且带 `Access-Control-Allow-Origin`。
6. **部署：注入 env**：按第 4 节整段复制；`MEDIA_BASE_URL` 私有桶模式**整行不写**（不是写空值）。
   本地先跑 `pnpm verify:prod-env`（零网络、28 个用例），失败就不要发布。
7. **发布应用**：打 `v*` tag → `images` workflow → deploy 侧把 `WEAVE_TAG` 锁到该 tag（不要 `latest`）。
   通过标准：`GET https://<api-domain>/api/health` 200；迁移日志无 pgvector 提示；容器无重启循环；
   **用真实租户生成一条报价分享链接，手机浏览器打开**（不是 curl API），必须落到正式域名而不是 `localhost`。
8. **回填文本向量**：`pnpm --filter @weave-order/api reindex:samples`
   通过标准：每个租户 `失败 0`；`sample_text_embeddings` 行数 ≈ 样品数；命令退出码 0。
9. **回填图像向量 + 建索引**：`pnpm --filter @weave-order/api reindex:images --ensure-index`
   通过标准：`失败 0`；`sample_image_embeddings` 行数 ≈ 可索引图片数；索引名含 `模型_维度`。
10. **冒烟**：`API_BASE=https://<api-domain> AUTH='<生产 PAT>' scripts/verify-media-e2e.sh` 输出 `PASS`；
    再按第 7 节验一次 `search-by-image`：`semantic=true`、`indexing=0`、top-K 有命中。
11. **不通过就回滚**：应用回旧 tag、env 回旧值、CORS 可改回；对象与向量按第 8 节区分可逆/不可逆，**不要删桶**。

> 主干到此为止。下面每节是执行细节、症状与排障；不需要通读也能按主干做完。

## 1. 必须人工执行（agent 不能做）

| 动作                                      | 谁                               | 预计耗时       | 做之前需要什么                                                        |
| ----------------------------------------- | -------------------------------- | -------------- | --------------------------------------------------------------------- |
| 在托管 PG 安装/启用 `vector` 扩展         | DBA / 云数据库管理员             | 5–20 分钟      | 实例高权限账号；确认实例版本在扩展白名单里（控制台「扩展/插件管理」） |
| 建 COS 桶、开版本控制、设置私有读写       | 云平台管理员（CAM 有建桶权限）   | 10 分钟        | 账号 APPID、地域、桶名规范（含 APPID）                                |
| 建 CAM 子账号、贴最小权限策略、发密钥     | 云平台管理员 + 安全负责人        | 15–30 分钟     | 第 3.2 节策略 JSON；secret 管理系统入口                               |
| 配 CORS、公开读/CDN（如选方案②）          | 云平台管理员 / 网络负责人        | 10–30 分钟     | 正式域名清单（Web、H5、管理端）；HTTPS 证书                           |
| 注入生产 secret（S3/embedding/四个 HMAC） | 部署负责人（有生产 secret 权限） | 15 分钟        | 第 4 节 env 清单；embedding key 由负责人从 DashScope 控制台创建       |
| 发布镜像并执行迁移                        | 部署负责人                       | 10–20 分钟     | 已合并的 `v*` tag；deploy 仓库的迁移步骤已确认会跑 `pnpm db:migrate`  |
| 回填与冒烟                                | SRE / 后端负责人                 | 10 分钟–2 小时 | 能连生产库的运维通道（只读优先）、生产 PAT、对象存储读权限            |
| 备份恢复演练（上线前/后各一次）           | DBA                              | 30–60 分钟     | 同版本临时实例 + pgvector 白名单；最近一次备份                        |

**agent 不会做也不会代做的**：申请真实云凭据、在生产库执行 DDL、改 deploy 仓库、真实部署、调用真实模型产生费用。

## 2. pgvector（S3/S4 的前置）

### 2.1 为什么必须先做

迁移 `0014_sample_text_embeddings.sql` 的第一句就是 `CREATE EXTENSION IF NOT EXISTS vector;`，
`0015` 建 `sample_image_embeddings.embedding vector` 与 HNSW 索引。应用账号（`weave_app`）没有建扩展权限，
所以**必须由 DBA 在业务库先建好**；否则 `pnpm db:migrate` 直接失败，发布卡在迁移步骤。

### 2.2 执行方式与权限

```bash
# 用实例的高权限账号连业务库（不是 weave_app），执行：
psql "host=<pg-host> port=5432 dbname=weave_order user=<admin> sslmode=require" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

需要的权限（任一即可）：

- PostgreSQL superuser；或
- 实例的「高权限账号 / 管理员账号」（云厂商通常映射为 `rds_superuser` + 扩展白名单）；或
- 普通角色 + 数据库 `CREATE` 权限 + `vector` 是 trusted extension（PG13+ 部分发行版如此，实际以托管商为准）。

托管 PG 的差异：

| 平台形态                      | 做法                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| 自建 `pgvector/pgvector:pg16` | 扩展已内置，本地/测试无需额外操作                                                                         |
| 腾讯云 PostgreSQL / TDSQL-C   | 控制台「插件管理 / 扩展管理」先确认 `vector` 可安装；没有该条目说明实例类型或小版本不支持，需升级或换实例 |
| 阿里云 RDS PostgreSQL         | 控制台「插件管理」安装 `vector`；部分版本要求先升级内核小版本                                             |
| 其它托管 PG                   | 查该实例的 `pg_available_extensions`；`installed_version` 为空但 `name=vector` 存在时才能建               |

### 2.3 失败长什么样，怎么判断

| 报错原文（大小写不敏感）                                   | 含义                        | 处理                                                        |
| ---------------------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| `permission denied to create extension "vector"`           | 角色权限不够                | 换高权限账号；不要给 `weave_app` 提权                       |
| `extension "vector" is not available`                      | 实例没装扩展包 / 不在白名单 | 控制台启用扩展或升级实例；自建机装 `postgresql-16-pgvector` |
| `could not open extension control file ... vector.control` | 同上，扩展文件不存在        | 同上                                                        |
| `extension "vector" does not exist`（查询 `\dx` 时）       | 还没建                      | 执行 `CREATE EXTENSION vector;`                             |

`pnpm db:migrate` 会把这些错误翻译成「请 DBA 执行 `CREATE EXTENSION vector`」后退出 1（见 `packages/db/src/migrate.ts`）。

### 2.4 验证

```sql
-- 1) 扩展已装
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- 2) 迁移后：列类型是 vector(N)，不是 real[]
SELECT attrelid::regclass AS table_name,
       attname,
       format_type(atttypid, atttypmod) AS column_type
FROM pg_attribute
WHERE attrelid IN ('sample_text_embeddings'::regclass, 'sample_image_embeddings'::regclass)
  AND attname = 'embedding';

-- 3) HNSW 索引存在（文本 / 图像各一条）
SELECT indexname FROM pg_indexes
WHERE tablename IN ('sample_text_embeddings', 'sample_image_embeddings')
  AND indexdef ILIKE '%hnsw%';
```

### 2.5 备份与恢复

扩展本身不随 `pg_dump` 的数据段落盘，恢复到新实例时需要目标实例同样支持 `vector`。
上线前做一次演练：同版本临时实例 → 启用扩展 → `pg_restore` → 跑第 2.4 节三条 SQL。
**没演练过的备份等于没有备份。**

回滚：不要 `DROP EXTENSION vector`。向量列/索引已依赖它，drop 会连带失败或毁数据；回滚应用版本时扩展留着无害。

## 3. 对象存储（腾讯云 COS，S3 兼容）

### 3.1 建桶

| 项       | 值                                                                              |
| -------- | ------------------------------------------------------------------------------- |
| 地域     | `ap-guangzhou`（与 API 同地域，避免跨区延迟/流量费）                            |
| 桶名     | `weave-media-prod-<APPID>`（COS 桶名必须带 APPID；S3 端点里也用全名）           |
| 访问权限 | **私有读写**（不要「公有读私有写」，除非走第 3.4 节方案②）                      |
| 版本控制 | **建议开启**：误覆盖/误删可恢复；配合生命周期清理非当前版本（如 30 天）控制成本 |
| 加密     | 服务端加密（SSE-COS）可直接开，应用无感                                         |

`S3_BUCKET` 必须写带 APPID 的全名，否则 S3 API 会返回 `NoSuchBucket`。

创建后验证（用子账号密钥，先经控制台上传一个 `tenant/probe/probe.txt`）：

```bash
export AWS_ACCESS_KEY_ID='<子账号 SecretId>'
export AWS_SECRET_ACCESS_KEY='<子账号 SecretKey>'
AWS="aws --endpoint-url https://cos.ap-guangzhou.myqcloud.com --region ap-guangzhou"
$AWS s3api head-object --bucket weave-media-prod-1250000000 --key tenant/probe/probe.txt
# 期望：输出 ContentLength / ETag / LastModified；403 说明策略或密钥不对，404 说明 key 写错
```

不要用 `head-bucket` 当验收集：它需要 `cos:HeadBucket`，与最小权限策略冲突，403 是预期的。

### 3.2 CAM 子账号与最小权限策略（可直接粘贴）

只允许该桶 `tenant/*` 前缀的四个对象操作。把 `<APPID>` 换成账号 APPID：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["cos:PutObject", "cos:GetObject", "cos:HeadObject", "cos:DeleteObject"],
      "resource": ["qcs::cos:ap-guangzhou:uid/<APPID>:weave-media-prod-<APPID>/tenant/*"]
    }
  ]
}
```

- 不够用时优先补**单个动作**，不要改成 `cos:*` 或挂 `QcloudCOSFullAccess`。
- 应用只用 presign（签名由服务端用该密钥生成）、HEAD（confirm）、GET（取原图算向量）、DELETE（预留）。
- 验证拒绝面：用同一密钥 `aws s3 ls`（列桶）应 403；访问另一个桶应 403。两者都拒绝才算收敛。

**为什么不能给主账号密钥**：主账号密钥等于整个腾讯云账号的所有资源（其他桶、CVM、账单、CAM 本身），
泄漏后无法按桶收敛、只能全账号轮换；子账号密钥可以随时禁用/轮换，且最坏影响面只有这一个桶前缀。

### 3.3 CORS（可直接粘贴）

S3 API 形式（`cors.json`）：

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://<web-domain>", "https://<mobile-h5-domain>"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["Content-Type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 600
    }
  ]
}
```

```bash
$AWS s3api put-bucket-cors --bucket weave-media-prod-1250000000 --cors-configuration file://cors.json
$AWS s3api get-bucket-cors --bucket weave-media-prod-1250000000
```

COS 控制台「安全管理 → 跨域访问 CORS」按同样字段填：

| 字段         | 值                                      |
| ------------ | --------------------------------------- |
| 来源 Origin  | 正式租户 Web / 移动端 H5 域名，一行一个 |
| 操作 Methods | `PUT`、`GET`、`HEAD`                    |
| 允许头部     | `Content-Type`                          |
| 超时 Max-Age | `600`                                   |

本地 `http://localhost:*` **只配 dev 桶**，不要进生产规则。只有真用自定义元数据时才加 `x-amz-*`；
`AllowedHeaders: ["*"]` 不是最小权限。

**移动端 H5 是独立 origin**：`https://weave-m.wnbgj.com` 必须单独列进 AllowedOrigins
（不能靠 `weave.wnbgj.com` 的通配或兄弟域名继承）。漏配时浏览器直传会在预检阶段被拦，
前端只看到 `Failed to fetch` / `TypeError`，接口日志里没有任何 PUT 记录。
走查发现的生产事故即属此类：移动端 H5 全部拍照入口 100% 失败（探针 `OPTIONS` 返回 403，
无 `Access-Control-Allow-Origin`）。

浏览器预检失败的典型报错（Chrome / Edge）：

```text
Access to XMLHttpRequest at 'https://cos.ap-guangzhou.myqcloud.com/...' from origin
'https://weave.wnbgj.com' has been blocked by CORS policy: Response to preflight request
doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present
on the requested resource.
```

COS 侧也可能直接回 403：`<Code>AccessForbidden</Code><Message>CORSResponse: This CORS request is not allowed...</Message>`。
原生 App 不走浏览器 CORS，所以「App 能传、H5 不能传」几乎一定是 CORS，不要当接口偶发失败查。

不依赖浏览器也能验一次预检（COS 虚拟主机风格，`S3_FORCE_PATH_STYLE=false` 时 presign 就是这个主机名）：

```bash
curl -sS -o /dev/null -D - -X OPTIONS \
  "https://weave-media-prod-<APPID>.cos.ap-guangzhou.myqcloud.com/tenant/probe/probe.txt" \
  -H "Origin: https://<web-domain>" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type"
# 期望 200/204，且响应头有 Access-Control-Allow-Origin: https://<web-domain>
```

### 3.4 公开读 / CDN 二选一

```text
默认（推荐先上）：私有桶 + 签名 URL
  MEDIA_BASE_URL 不设置（整行删掉）
  → GET /api/samples/:id 的 images[].url 是带签名的临时 URL，TTL = MEDIA_PRESIGN_TTL_SECONDS
  → 优点：桶没有公开面；换 CDN 只改 env，不动数据库（DB 只存 object_key）
  → 代价：URL 每次刷新都变，CDN 基本无法缓存；图片墙流量大时再升级

方案②：公开读（或 CDN 回源鉴权）+ MEDIA_BASE_URL
  MEDIA_BASE_URL=https://cdn.<你的域名>
  → images[].url = <MEDIA_BASE_URL>/<object_key>，不再签名
  → 前置：桶策略允许公开读（或仅允许 CDN 回源）；对象 key 含 UUID，不可枚举
  → 优点：长缓存、移动端弱网友好；代价：多一个公开面与 CDN 配置面
```

| 配置                           | 症状                                                              | 处理                                                  |
| ------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- |
| 桶私有 + 填了 `MEDIA_BASE_URL` | `images[0].url` 直接 GET 返回 403 `AccessDenied`；图片墙全裂      | 改回签名 URL（删掉该变量）或按方案②开公开读           |
| 桶公开 + 没配 `MEDIA_BASE_URL` | 能用，但每张图都是签名 URL，CDN 命中率 0；URL 过期后旧页面图裂    | 配 CDN 域名                                           |
| `MEDIA_BASE_URL` 多了/少了斜杠 | URL 变成 `https://cdn/...//tenant/...` 或 404                     | 只写到域名（可带路径前缀，不要尾部 `/`）              |
| `MEDIA_BASE_URL` 用 http       | 服务端按 URL 取图（`imageUrl` 变体）拒绝：`imageUrl 必须是 https` | 生产只能是 https；`MEDIA_BASE_URL` 主机会自动进白名单 |

CDN 细节（方案②）：只缓存 GET；上传直传域名不挂缓存；HTTPS 证书与桶域名一致；
删除/覆盖对象后按需刷新 URL；不要缓存 PUT 响应或 4xx/5xx。

## 4. 环境变量（可直接粘贴）

### 4.1 生产值

```dotenv
# ---------- 生产模式（缺一不可） ----------
NODE_ENV=production
AUTH_MODE=oidc
# 业务连接必须是 weave_app（NOSUPERUSER / NOBYPASSRLS），迁移/回填用另一条高权限连接
APP_DATABASE_URL=postgres://weave_app:<轮换后的口令>@<pg-host>:5432/weave_order
# 四个 HMAC secret：生产用占位值会拒绝启动；ONBOARDING_SECRET 必须与 platform-api 完全一致
QUOTE_SHARE_SECRET=<openssl rand -hex 32>
PRINT_AGENT_SECRET=<openssl rand -hex 32>
PERSONAL_TOKEN_PEPPER=<openssl rand -hex 32>
ONBOARDING_SECRET=<openssl rand -hex 32>
# 客户报价页 / 开通链接 / CLI 登录确认页的站点根地址。
# 不设或写 localhost = 生成的链接客户在微信里白屏，API 日志却全是 200；
# 生产/OIDC 模式必须 https 且非 localhost，否则拒绝启动（WAN-130）。
PUBLIC_APP_URL=https://<quote-域名>
WEB_APP_URL=https://<租户端域名>
# 租户端 Web（apps/web）也要拿到同一个 AUTH_MODE：它决定 Secure cookie、
# 缺令牌不放行、开发登录入口是否关闭、演示模式是否可用（WAN-135）。
# 不配时 web 只按 NODE_ENV 判定，staging（NODE_ENV=development + AUTH_MODE=oidc）会漏判。
# AUTH_MODE=oidc  # web 容器同样注入这一行
# 控制面：不设 = 自助开通的公司不登记试用订阅（onboarding 只跳过登记，不报错）。
# 生产/OIDC 模式缺失会拒绝启动（WAN-130）。
PLATFORM_API_URL=https://<platform-api-domain>
# 出站通知：默认 log 只写日志，用户收不到任何提醒；生产必须 webhook。
NOTIFY_PROVIDER=webhook
NOTIFY_WEBHOOK_URL=https://<notify-gateway>/send

# ---------- 对象存储（腾讯云 COS，S3 兼容） ----------
S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
S3_REGION=ap-guangzhou
S3_BUCKET=weave-media-prod-<APPID>
S3_ACCESS_KEY_ID=<子账号 SecretId>
S3_SECRET_ACCESS_KEY=<子账号 SecretKey>
S3_FORCE_PATH_STYLE=false
# 私有桶 + 签名 URL：这一行不要写（不是写空值）
# MEDIA_BASE_URL=https://cdn.<你的域名>
MEDIA_PRESIGN_TTL_SECONDS=600
MEDIA_MAX_BYTES=10485760
# 私有桶 + imageUrl 找样时加 <bucket>.cos.ap-guangzhou.myqcloud.com；
# 历史域名 / 额外 CDN 同理。MEDIA_BASE_URL 的主机会自动并入，不需要重复。
# MEDIA_ALLOWED_HOSTS=

# ---------- 文本向量（S3） ----------
EMBEDDING_PROVIDER=dashscope-text-v3
EMBEDDING_MODEL=text-embedding-v3
EMBEDDING_DIMENSION=1024
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=<DashScope key>
EMBEDDING_TIMEOUT_MS=20000
EMBEDDING_MAX_ATTEMPTS=3
SEARCH_SEMANTIC_MIN_SCORE=0.5

# ---------- 图像向量（S4） ----------
IMAGE_EMBEDDING_PROVIDER=dashscope-qwen3-vl
IMAGE_EMBEDDING_MODEL=qwen3-vl-embedding
IMAGE_EMBEDDING_DIMENSION=1024
IMAGE_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/api/v1
IMAGE_EMBEDDING_API_KEY=<DashScope key；可与文本共用>
IMAGE_EMBEDDING_TIMEOUT_MS=20000
IMAGE_EMBEDDING_MAX_ATTEMPTS=3
IMAGE_EMBEDDING_MAX_EDGE=512
SEARCH_IMAGE_MIN_SIMILARITY=0.75
SEARCH_IMAGE_TEXT_MIN_SIMILARITY=0.35
CAPTION_FALLBACK=false
CAPTION_MODEL=qwen3-vl-plus
CAPTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

> **空值 ≠ 未设置**：`MEDIA_BASE_URL` 是 `url().optional()`，`EMBEDDING_API_KEY` /
> `IMAGE_EMBEDDING_API_KEY` 是 `min(1).optional()`。写成 `MEDIA_BASE_URL=` / `EMBEDDING_API_KEY=`
> 会被 zod 拒绝，进程起不来；不用它们时**整行删掉/不注入**。

### 4.2 逐项默认值、必填性与配错症状

| 变量                                 | 生产值 / 默认值                                  | 必填               | 配错会长什么样                                                                                                          |
| ------------------------------------ | ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`                        | COS 地域端点 / `http://localhost:9000`           | 是                 | 指向 MinIO 或错地域 → presign 域名不对，PUT 超时/403；provider 端 5xx                                                   |
| `S3_REGION`                          | `ap-guangzhou` / `us-east-1`                     | 是                 | SigV4 签名地域不符 → `AuthorizationHeaderMalformed` / `SignatureDoesNotMatch`                                           |
| `S3_BUCKET`                          | 带 APPID 的桶名 / `weave-media`                  | 是                 | 不带 APPID → `NoSuchBucket`；桶名写错 → 上传/confirm 5xx                                                                |
| `S3_ACCESS_KEY_ID`                   | 子账号 SecretId / `weave-media`                  | 是                 | 缺省回落 dev 占位值，生产态启动即抛「必须显式配置 S3_ACCESS_KEY_ID」                                                    |
| `S3_SECRET_ACCESS_KEY`               | 子账号 SecretKey / `weave-media-secret`          | 是                 | 密钥与 ID 不匹配 → presign 能出 URL 但 PUT 403 `SignatureDoesNotMatch`                                                  |
| `S3_FORCE_PATH_STYLE`                | `false` / `true`（生产必须显式 `false`）         | 是                 | COS 上设 `true` → 签名主机名/路径错，浏览器 PUT 403，confirm HEAD 当对象不存在；生产漏配/`true` 直接拒绝启动（WAN-130） |
| `PUBLIC_APP_URL`                     | `https://<quote-域名>` / `http://localhost:5174` | 生产必填           | 漏配/非 https → 客户报价链接指向 localhost，微信打开白屏；生产态直接拒绝启动（WAN-130）                                 |
| `WEB_APP_URL`                        | `https://<租户端域名>` / `http://localhost:3001` | 生产必填           | 漏配/非 https → 开通链接、CLI 登录确认页指向 localhost；生产态直接拒绝启动（WAN-130）                                   |
| `AUTH_MODE`（web 也要注入）          | `oidc` / `dev`                                   | 生产必填           | web 容器漏配 → 只按 `NODE_ENV` 判定，staging（`NODE_ENV=development`）会下发非 Secure cookie、放开开发登录入口与演示模式（WAN-135） |
| `PLATFORM_API_URL`                   | 控制面地址 / 不设                                | 生产必填           | 不设 → 自助开通的公司不会被登记试用订阅；生产态直接拒绝启动（WAN-130）                                                  |
| `NOTIFY_PROVIDER`                    | `webhook` / `log`                                | 生产必填 `webhook` | 保持 `log` → 邀请、试用到期等提醒只写服务端日志，用户永远收不到；生产态直接拒绝启动（WAN-130）                          |
| `MEDIA_BASE_URL`                     | 私有桶：不写；CDN：`https://cdn.<域名>`          | 方案②必填          | 私有桶填了 → 图片 403；写空字符串 → 启动失败；末尾多 `/` → 双斜杠/404                                                   |
| `MEDIA_PRESIGN_TTL_SECONDS`          | `600`                                            | 否                 | 过小（<60）→ 慢网上传/看图大面积过期；过大 → URL 泄漏窗口变长                                                           |
| `MEDIA_MAX_BYTES`                    | `10485760`                                       | 否                 | 超过 10MB 上限会被 zod `.max` 拒绝启动；调小 → 正常手机图被 `图片超过体积上限`                                          |
| `MEDIA_ALLOWED_HOSTS`                | 空 / 额外 CDN 域名，逗号分隔                     | 否                 | 用 `imageUrl` 找样但主机未在白名单 → `UPSTREAM_UNAVAILABLE: 主机不在白名单`；只写主机名，不带 `https://`                |
| `EMBEDDING_PROVIDER`                 | `dashscope-text-v3` / `local-stub`               | 是                 | 名字拼错（如 `text-embedding-v3`）→ 首个请求 5xx「尚未接入」；`local-stub` → 不做语义检索                               |
| `EMBEDDING_MODEL`                    | `text-embedding-v3`                              | 否                 | 改成模型不支持的维度 → 上游 400；模型名错 → 上游 404，接口 5xx                                                          |
| `EMBEDDING_DIMENSION`                | `1024`                                           | 是                 | ≠1024 且真实 provider → 启动即抛「与 vector(1024) 不一致」                                                              |
| `EMBEDDING_BASE_URL`                 | 通义兼容端点                                     | 否                 | 网关未收录该模型 → 404/400，语义检索 5xx                                                                   |
| `EMBEDDING_API_KEY`                  | DashScope key                                    | 真实 provider 必填 | 缺 key → 启动即抛「需要 EMBEDDING_API_KEY」（不静默回退哈希）                                                           |
| `EMBEDDING_TIMEOUT_MS`               | `20000`                                          | 否                 | 过小 → 高峰期 embedding 超时、接口 5xx；重试掩盖不了，先看上游延迟                                                      |
| `EMBEDDING_MAX_ATTEMPTS`             | `3`                                              | 否                 | 设为 1 → 瞬时 429/5xx 直接暴露；过大 → 故障时请求堆积                                                                   |
| `SEARCH_SEMANTIC_MIN_SCORE`          | `0.5`                                            | 否                 | 调太低 → 无关结果混入；调太高 → 语义补足永远为空（ILIKE 仍可用）                                                        |
| `IMAGE_EMBEDDING_PROVIDER`           | `dashscope-qwen3-vl` / `local-stub`              | 是                 | 拼错 → 启动即抛「尚未接入」（bootstrap 里 eager 创建）；`local-stub` → 演示模式，分数无意义                             |
| `IMAGE_EMBEDDING_MODEL`              | `qwen3-vl-embedding`                             | 否                 | 换模型不换维度 → 启动维度校验或回填时「已存在索引维度不一致」                                                           |
| `IMAGE_EMBEDDING_DIMENSION`          | `1024`                                           | 是                 | 不在 `256/512/768/1024/1536/2048/2560` → 启动即抛                                                                       |
| `IMAGE_EMBEDDING_BASE_URL`           | `https://dashscope.aliyuncs.com/api/v1`          | 否                 | 误填 OpenAI 兼容端点（`/compatible-mode/v1`）→ 405/404，图像向量不可用                                                  |
| `IMAGE_EMBEDDING_API_KEY`            | DashScope key                                    | 真实 provider 必填 | 缺 key → 启动即抛「需要 IMAGE_EMBEDDING_API_KEY」                                                                       |
| `IMAGE_EMBEDDING_TIMEOUT_MS`         | `20000`                                          | 否                 | 过小 → 大图/冷启动超时；回填出现大量 `failed`                                                                           |
| `IMAGE_EMBEDDING_MAX_ATTEMPTS`       | `3`                                              | 否                 | 同文本                                                                                                                  |
| `IMAGE_EMBEDDING_MAX_EDGE`           | `512`                                            | 否                 | 调大 → 成本上升、分离度基本不变；设为 0 → 原图直送，token 顶到 1225 封顶                                                |
| `SEARCH_IMAGE_MIN_SIMILARITY`        | `0.75`                                           | 否                 | 旧值 0.55 → 浅蓝牛仔 vs 灰针织被当同款；>0.9 → 同款异角度也筛掉                                                         |
| `SEARCH_IMAGE_TEXT_MIN_SIMILARITY`   | `0.35`                                           | 否                 | 套用 0.75 → caption 兜底永远返回空                                                                                      |
| `CAPTION_FALLBACK`                   | `false`                                          | 否                 | 开着 + 文本仍 `local-stub` → 启动即抛；上游故障时静默换链路会掩盖模型不可用                                             |
| `CAPTION_MODEL` / `CAPTION_BASE_URL` | `qwen3-vl-plus` / 兼容端点                       | 仅兜底开时         | 模型名错 → `mode=caption` 的请求 5xx                                                                                    |

> **私有桶 + `imageUrl` 找样的白名单陷阱**：`MEDIA_BASE_URL` 为空时，服务端只把
> `S3_ENDPOINT` 的主机名（`cos.ap-guangzhou.myqcloud.com`）当默认白名单；而 COS 的签名 URL
> 是虚拟主机风格（`<bucket>.cos.ap-guangzhou.myqcloud.com`），两者不相等。若移动端用
> 「上传后拿 URL 再找样」的 `imageUrl` 变体，必须显式加：
> `MEDIA_ALLOWED_HOSTS=<bucket>.cos.ap-guangzhou.myqcloud.com`。用 CDN 模式时 `MEDIA_BASE_URL`
> 的主机会自动并入，不需要重复。

## 5. 上线顺序（每一步单独成一步，便于归因）

```text
① DBA 扩展 → ② 桶 / 子账号 / CORS → ③ secret 注入 → ④ 应用发布 + 迁移
   → ⑤ 文本回填 → ⑥ 图像回填 + 索引 → ⑦ 冒烟 → ⑧（可选）CDN/公开读
```

- ① 与 ② 可以并行，但都必须在 ④ 之前完成；③ 必须在 ④ 启动前注入（否则生产门禁直接拒绝启动）。
- ④ 之前用 `pnpm verify:prod-env` 校验 env 组合（见第 9 节）。
- ④ 的迁移必须由部署流程执行 `pnpm db:migrate`。deploy 仓库不在本工作区，执行人要核对它的
  发布步骤确实包含迁移；**不要手工只跑应用容器而不跑迁移**。
- ⑤⑥ 在 ④ 之后、对外宣布可用之前完成。回填不影响新数据写入，但结果不全会让搜索看起来「不准」。
- ⑧ 单独做、单独验证：CORS/CDN 改动与代码发布混在一起时，出问题无法判断是代码还是网络。

发布动作（本仓库侧）：

```bash
git tag -a v0.x.y -m "release v0.x.y" && git push origin v0.x.y
# images workflow 会先等该提交 ci 全绿，再构建并推送 sjzsdu/weave-order:<tag>
# deploy 侧：WEAVE_TAG=v0.x.y（不要 latest），先迁移后滚动更新
```

## 6. 回填

### 6.1 顺序、命令、耗时

```bash
# 0) 前置：DATABASE_URL 用迁移/高权限连接（回填要跨租户读全量数据）
#    先确认这条连接能看到数据：
#    psql "$DATABASE_URL" -c "select count(*) from samples;"   -- 必须 > 0
pnpm --filter @weave-order/api reindex:samples
pnpm --filter @weave-order/api reindex:images --ensure-index
```

- **顺序不能反**：先文本（便宜、几分钟），再图像（贵、需要读对象存储）。
  图像回填依赖桶与子账号已就绪；`--ensure-index` 要带上，否则新模型没有 partial HNSW 索引。
- 可以按租户分批：两条命令都支持 `-- --tenant=<uuid>`，先小租户验证再全量。
- 失败行会保留 `failed` 状态，重跑同一条命令即可（只补缺失/失败行，幂等）；不要删表重来。

如果本次发布同时包含缩略图 / 媒体治理（`docs/media-thumbnails.md`），再补一轮派生与孤儿回收：

```bash
pnpm --filter @weave-order/api maintain:media -- --dry-run   # 只读：看收益与孤儿/查询图占用，不写库不写桶
pnpm --filter @weave-order/api maintain:media                # 补派生 + 压原图 + 清孤儿 + 清查询图（各有保护期）
```

> **连接要求（阻断级）**：`sample_images` 是 FORCE RLS。CLI 会为每个租户开启
> `withTenantSession`（`SET app.tenant_id`）再清理，所以**必须按租户执行**：
> 用业务角色 `weave_app` 时无法列举租户（RLS 返回空），命令会显式失败，
> 此时加 `-- --tenant=<uuid>` 逐个执行；不要为了「省事」换成高权限连接后直接用旧版脚本。
> 清理方法内还有一道自检：角色受 RLS 约束且没有租户上下文时直接拒绝，不会带着空引用集合删除。
> 查询图回收会把仍被 `sample_images` 引用的 `uploads/` 对象计入白名单（先直传、再随建样品提交是合法契约）。

耗时公式（命令是串行的，量级估算，现场以实际日志为准）：

| 任务              | 公式（N=样品数，M=图片数）                         | 1 万条/张的估算 | 成本参考                          |
| ----------------- | -------------------------------------------------- | --------------- | --------------------------------- |
| `reindex:samples` | `ceil(N/10) × 0.4s` + 写库 `N × 2ms`               | 7–12 分钟       | 以 DashScope 账单为准             |
| `reindex:images`  | `M × (下载 0.1–0.3s + 缩图 0.05s + 模型 0.3–0.6s)` | 75–160 分钟     | 约 0.46 元/千张 → 1 万张 ≈ 4.6 元 |

图像回填是串行单张调用（`ImageIndexService` 每次一张图），不要指望 CLI 自己并发；
需要更快时按租户拆给多个 worker 会放大限流风险，先按单租户实测再决定。

索引构建的锁：`ensureHnswIndex()` 用的是普通 `CREATE INDEX IF NOT EXISTS`（非 CONCURRENTLY）。
刚迁移完的表是空的，建索引瞬间完成；**如果表里已有大量向量再补建索引，会短暂阻塞该表写入**，
应放在维护窗口，或由 DBA 先手工 `CREATE INDEX CONCURRENTLY` 建好同名索引（脚本检测到同名会跳过）。

### 6.2 回填期间用户会看到什么

| 功能                | 回填期间的真实表现                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| 上传/建样品带图     | 正常，HTTP 立即返回，上传后图片立即可看；样例图列表**没有任何索引状态提示**                      |
| 样例图列表          | 读模型不暴露 `index_status`；客服无法从界面判断某张图是否已进检索（产品缺口，见下）              |
| 以图找样            | 相机页提示「还有 N 张图在建立索引，稍后重试」，结果条标「· 还有 N 张图索引中」；未索引图不进结果 |
| 文字找样            | 不报错；未回填样品只能被 ILIKE 命中，语义补足缺失，召回质量低                                    |
| 模型/对象存储不可用 | 回填把该行标 `failed` 并继续；接口在查询时明确 5xx（不会回退哈希向量伪装成功）                   |
| 后台补漏            | 该租户下次找样会触发一次补漏（60s 节流）；进程重启不丢任务，行仍是 `pending`                     |

> 上表第 2 行是**产品缺口**：`index_status` 只在找样接口的 `indexing` 计数里体现，
> 图列表没有逐图标记。回填期客服被问「这张图现在能不能搜到」时无法自证。
> 建议单独挂 P1：样例图列表对 `pending/failed` 给一个轻标记（本 PR 不改前端）。

回填完成后核对：

```sql
-- pending / failed 应为 0（RLS 生效时需在对应租户会话里查，或用高权限连接）
select tenant_id, count(*) from sample_images where index_status = 'pending' group by 1;
select tenant_id, count(*) from sample_images where index_status = 'failed' group by 1;
select tenant_id, model, count(*) from sample_image_embeddings group by 1, 2;
select tenant_id, model, count(*) from sample_text_embeddings group by 1, 2;
```

若连接被 RLS 过滤（`select count(*) from samples` 为 0 而应用有数据），不要判定「没有数据」：
换迁移/高权限连接，或让 DBA 给回填账号临时 `BYPASSRLS`（用完即撤）。

## 7. 冒烟（生产参数）

```bash
API=https://<api-domain>          # 例：https://weave-api.wnbgj.com（以实际部署为准）
TOKEN='<生产个人访问凭据 PAT>'

# 1) 健康
curl -fsS "$API/api/health"

# 2) 图片全链路：presign → PUT → confirm → GET images[].url（复用仓库脚本）
API_BASE="$API" AUTH="$TOKEN" scripts/verify-media-e2e.sh
# 期望最后一行：PASS: presign → PUT → confirm → GET /api/samples/<id>（images=1）全链路通过
# （images 至少为 1；按字面 grep 时用 `PASS:`，不要 grep `images>=1`）
# 库里没有样品时脚本会停在「没有可用样品」；先建一条样品，或显式传 SAMPLE_ID=<uuid>
```

```bash
# 3) 以图找样：拿上一步样品的图片 URL 作为查询图
SID='<上一步的样品 id>'
IMG=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$API/api/samples/$SID" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sample.images[0].url))')
curl -fsS -X POST "$API/api/tools/search-by-image" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({imageUrl:process.argv[1],topK:5}))' "$IMG")"
# 期望：ok=true；semantic=true；indexing=0；mode=image；matches 里第 1 条是自己（score 接近 1）
```

```bash
# 4) 文本找样（用真实语义查询，长度 ≥8 / 含空格或英文才会追加向量检索）
curl -fsS -X POST "$API/api/tools/search-by-spec" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"蓝色 牛仔 弹力","limit":5}'
# 期望：ok=true；能出现 matchedOn:["semantic"] 的补足结果
```

通过标准：步骤 2 输出 `PASS`；3 的 `semantic=true` 且 `indexing=0`；4 有 `semantic` 命中。
如果 3 返回 `semantic=false` 或 `演示模式：哈希向量`，说明发布时仍是 `local-stub`，回第 4 节查 env。

## 8. 回滚：哪些可逆、哪些不可逆

| 动作                                     | 可逆？                 | 怎么回 / 注意                                                                                               |
| ---------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| 应用镜像 / 代码版本                      | 可逆                   | deploy 侧 `WEAVE_TAG` 改回上一个 tag；旧版本不读新表，不需要删数据                                          |
| `S3_*` / `MEDIA_*` / `*_EMBEDDING_*` env | 可逆                   | 改回旧值并重启；**不要**改回 dev 占位值（生产门禁会拒绝启动）                                               |
| CORS / `MEDIA_BASE_URL` / CDN            | 可逆                   | 改回旧规则/旧域名，重新跑第 7 节冒烟                                                                        |
| CAM 子账号密钥                           | 可逆                   | 新建 Key 轮换，旧 Key 禁用；不影响数据                                                                      |
| 回填出的向量行 / HNSW 索引               | 可逆（派生数据）       | 删行/`drop index` 后重算即可，代价是再花一次模型费用与时间；不要删原图                                      |
| 已上传的对象                             | **不可逆**             | 回滚代码不会删对象；版本控制可恢复覆盖/删除，但桶删除不可恢复。孤儿对象用 `maintain:media` 回收（有保护期） |
| `sample_images` 行                       | 可逆（有备份时）       | 行是弱一致（先传对象后 confirm）；回滚代码不会清行，历史图仍可看                                            |
| 迁移 `0014` / `0015`                     | **不可逆（前滚）**     | 没有 down migration；不要手工 drop 表。出问题用备份恢复到新实例                                             |
| `CREATE EXTENSION vector`                | **不可逆（事实上的）** | 向量列依赖它，不要 drop；留着无害                                                                           |
| 删除 COS 桶                              | **不可逆**             | 任何情况下都不要用「删桶」回滚；删桶会带走全部原图                                                          |

回滚演练的最低要求：在 staging 用上一个 `WEAVE_TAG` 起一次，确认旧版本在**新表存在**、
`S3_*` 已注入的情况下能正常读写；不要假设「旧版本不认识这些表就没事」。

## 9. 自动化：生产 env 启动 fail-fast 校验

```bash
pnpm verify:prod-env
# 等价：pnpm --filter @weave-order/api verify:prod-env
# 只跑一个文件：apps/api/test/production-env-gate.test.ts，零网络、无需数据库
```

它复刻启动期会执行的部分：`loadEnv → 图像 provider（main.ts eager） → 文本 provider（生产上首个请求才建，这里提前断言）`，
并直接读取 §4.1 的 dotenv 块喂给 `loadEnv`，所以文档与门禁不会各写一份。覆盖 **28 个用例**
（下表按类归并；CI 的 `pnpm test` 也会跑，不需要改 workflow）：

| 组合                                                  | 期望                                 |
| ----------------------------------------------------- | ------------------------------------ |
| 生产 + 完整真实配置                                   | 能启动                               |
| 缺 `S3_ACCESS_KEY_ID`（回落 dev 占位）                | 拒绝启动                             |
| 生产用 dev 占位 S3 凭据                               | 拒绝启动                             |
| 真实图像 provider 缺 key                              | 拒绝启动                             |
| 图像维度 `999` 不受支持                               | 拒绝启动                             |
| 文本维度 `512` 与 `vector(1024)` 不符                 | 拒绝启动                             |
| 未知文本 provider（名字拼错）                         | 门禁提前抛；**生产实际首个请求才抛** |
| 未知图像 provider（名字拼错）                         | 拒绝启动（main.ts eager 创建）       |
| `CAPTION_FALLBACK=true` + 文本 `local-stub`           | 拒绝启动                             |
| `MEDIA_BASE_URL=` / `EMBEDDING_API_KEY=` 空字符串     | 拒绝启动（可选变量要整行删）         |
| 四个 HMAC secret 回落 dev 占位值                      | 拒绝启动                             |
| 未设 `PUBLIC_APP_URL`（回落 `http://localhost:5174`） | 拒绝启动（WAN-130）                  |
| `PUBLIC_APP_URL` 不是 https                           | 拒绝启动（WAN-130）                  |
| 未设 `WEB_APP_URL`（回落 `http://localhost:3001`）    | 拒绝启动（WAN-130）                  |
| 未设 / 写了 `S3_FORCE_PATH_STYLE=true`                | 拒绝启动（WAN-130）                  |
| 未设 `PLATFORM_API_URL` / 指向本机                    | 拒绝启动（WAN-130）                  |
| `NOTIFY_PROVIDER=log`（含未设置）                     | 拒绝启动（WAN-130）                  |
| `NOTIFY_PROVIDER=webhook` 但缺 `NOTIFY_WEBHOOK_URL`   | 拒绝启动（WAN-130）                  |
| 按生产配置生成一条分享链接                            | host 不是 localhost，落到正式域名    |
| §4.1 整段 dotenv（私有桶 / CDN 两种）                 | 都能启动                             |
| 本地默认组合（零 key）                                | 能启动，不误伤开发                   |

`PUBLIC_APP_URL` / `WEB_APP_URL` 的校验规则（生产/OIDC 模式）：必须是 https，且 host 不是
`localhost` / `127.0.0.1` / `*.localhost` / `0.0.0.0` / `host.docker.internal`。
分享链接的拼装点只有一处（`buildShareUrl`），门禁与真实接口走同一个函数，所以「测试断言的不是线上那条链接」不会发生。

### 9.1 缺口表：逐条状态（WAN-130 复核）

原评审发现的问题在这里逐条落状态，不留「未处理也未记录」。状态只有三种：
**已修**（代码或门禁已兜住）、**待产品决定**（需要业务口径）、**接受风险**（明确不修，写清后果与补偿手段）。

| #   | 缺口                                                                | 状态         | 处置与证据                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 未知 `EMBEDDING_PROVIDER` 生产要等首个请求才抛                      | 接受风险     | 门禁在发布前提前断言（§9 表）；不改 `main.ts` 装配顺序，避免动业务启动路径。                                                                                                                                                  |
| 2   | `NODE_ENV=production` + `AUTH_MODE=dev` 的拦截在 `main.ts` 不在 env | 已修         | `main.ts` 已有拦截；门禁全部生产用例以 `AUTH_MODE=oidc` 组合运行，§4.1 也写死 `AUTH_MODE=oidc`。                                                                                                                              |
| 3   | `MEDIA_BASE_URL` 不强制 https                                       | 待产品决定   | 服务端按 URL 取图已拒绝 http（localhost 除外）；是否在生产禁止 http 的 CDN 需确认是否存在内网 http 场景。                                                                                                                     |
| 4   | `PUBLIC_APP_URL` / `WEB_APP_URL` 漏配静默回落 localhost             | 已修         | `loadEnv` 生产态拒绝 localhost/非 https；三段负向用例 + 一条「分享链接 host 不是 localhost」正向用例。                                                                                                                        |
| 5   | `S3_FORCE_PATH_STYLE` 漏注入静默 true                               | 已修         | `loadEnv` 生产态拒绝 `true`（含默认回落），门禁覆盖「未设置」与「显式 true」。                                                                                                                                                |
| 6   | `PLATFORM_API_URL` 不设时自助开通静默跳过试用订阅                   | 已修         | `loadEnv` 生产态强制必填且拒绝本机地址；§4.1 已改为未注释的生产值。                                                                                                                                                           |
| 7   | `NOTIFY_PROVIDER` 默认 log，邀请/到期提醒静默不发                   | 已修         | `loadEnv` 生产态强制 `webhook` 且要求 `NOTIFY_WEBHOOK_URL`（拒绝本机地址）。                                                                                                                                                  |
| 8   | `sample_images` 删除后桶里对象未删                                  | 已修         | `maintain:media` 的 `cleanupOrphanedObjects` 按 DB 引用反查、24h 保护期；CLI 按租户开启 `withTenantSession`，无租户上下文（受 RLS 约束）直接拒绝执行；`sample-images.service.ts` 的 TODO 已指向该实现。                       |
| 9   | 移动端以图找样的查询图（`uploads/`）无清理策略                      | 已修         | `maintain:media -- --uploads-retention-days=7`（默认 7 天，`--skip-uploads` 可跳过）；`uploads/` key 可随 `POST /api/samples` 的 `imageKeys` 入库，回收先按 `sample_images` 引用建白名单；`media-cleanup.test.ts` 11 条用例。 |
| 10  | 孤儿/查询图「占用多少」没有实测                                     | 已修（口径） | CLI 每项先打印条数与字节（`listed*` / `candidate*` / `deleted*`）与「仍被引用」数；已用本地非 BYPASSRLS 角色复验「只删孤儿、引用对象保留」。生产桶数字仍需在执行后回填本文。                                                  |
| 11  | `receipts/` 回款凭证没有回收策略                                    | 接受风险     | 凭证是财务凭据，需长期留存；明确不纳入自动回收，容量成本由业务接受。                                                                                                                                                          |
| 12  | 回填耗时只是估算                                                    | 接受风险     | 首次回填按租户记录实际速度并回填第 10 节公式，不做无实测的容量承诺。                                                                                                                                                          |
| 13  | 控制面 `apps/platform-api` 的 `NOTIFY_PROVIDER` 默认也是 `log`      | 待产品决定   | 试用到期提醒由控制面发送；控制面独立部署、独立 env 契约，不在本文档的注入清单内，需在控制面部署清单单独加同样的门禁。                                                                                                         |
| 14  | 查询图回收的引用白名单只覆盖 `sample_images`                        | 接受风险     | 当前唯一会把 `uploads/` key 入库的路径是 `POST /api/samples` 的 `imageKeys`；未来若有新功能复用该前缀，必须同步加入白名单，否则对象会在保留期后被回收。                                                                       |

## 10. 上线检查单（打印出来逐项打勾）

- [ ] `SELECT extversion FROM pg_extension WHERE extname='vector'` 有值
- [ ] 桶私有读、版本控制开、桶名带 APPID
- [ ] 子账号只授权 `tenant/*` 四个动作；列桶/别的桶均 403
- [ ] CORS 预检 204/200，`Access-Control-Allow-Origin` 命中正式域名
- [ ] 生产 env 由 secret 注入；`pnpm verify:prod-env` 通过；`MEDIA_BASE_URL` 按方案取舍
- [ ] `PUBLIC_APP_URL` / `WEB_APP_URL` 指向正式域名；报价分享链接手机打开不是 localhost
- [ ] `S3_FORCE_PATH_STYLE=false` 显式注入（生产默认是 true，漏了会静默 path-style，门禁会拒绝启动）
- [ ] `PLATFORM_API_URL` 指向控制面正式地址；`NOTIFY_PROVIDER=webhook` 且 `NOTIFY_WEBHOOK_URL` 可发送（WAN-130）
- [ ] `maintain:media --dry-run` 看过孤儿对象与查询图的条数/字节；再执行一次（保留期默认 7 天，不删新对象）
- [ ] `v*` tag 的 ci 全绿；`WEAVE_TAG` 锁定到具体 tag；迁移已执行
- [ ] `/api/health` 200；日志无 S3/pgvector/embedding 配置错误
- [ ] `reindex:samples` 与 `reindex:images --ensure-index` 均退出 0
- [ ] `verify-media-e2e.sh` PASS；`search-by-image` `semantic=true`、`indexing=0`
- [ ] 回滚方案已确认：上一个 `WEAVE_TAG`、env 旧值、备份恢复演练记录
