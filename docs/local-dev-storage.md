# 本地对象存储（MinIO）不依赖 Docker Hub 的起停方式

> 适用：S1 图片链路（presign → PUT → confirm → 样品带图）的本地联调与验收。
> 生产侧可执行 runbook（pgvector / COS / 权限 / CORS / env / 回填 / 回滚）见
> [`media-production-checklist.md`](./media-production-checklist.md)。

## 为什么需要这个脚本

`samples` 的图片链路需要 S3 兼容对象存储。`docker-compose.yml` 里的 `minio` / `minio-init`
在能访问 Docker Hub 的机器上是首选；但在国内或受限网络下：

```text
$ curl -m 8 https://registry-1.docker.io/v2/
curl: (28) Connection timed out
$ docker manifest inspect minio/minio:latest
（超时）
```

镜像拉不下来，`docker compose up` 会失败，本地验收链路就永远只能"已实现未验证"。
`scripts/dev-storage-up.sh` 改为直接运行 MinIO 官方单文件二进制（官方国内镜像
`dl.minio.org.cn` 可达），端口、凭据、bucket 与 compose 完全一致，API 侧零配置差异。

## 快速开始

```bash
# 1. 起对象存储（首次会下载 minio + mc，约 135MB，带 sha256 校验）
scripts/dev-storage-up.sh

# 2. 数据库与样品种子（已有可跳过）
pnpm db:migrate && pnpm seed

# 3. 起 API（默认 3000；被占用时换端口）
pnpm --filter @weave-order/api dev

# 4. 可重复验收：presign → PUT → confirm → GET /api/samples/:id
scripts/verify-media-e2e.sh
```

`verify-media-e2e.sh` 默认 `API_BASE=http://127.0.0.1:3000`、`AUTH=dev:demo:demo`，
自动挑一条样品、生成 1x1 PNG 上传，并复核 `images[0].url` 真能取到图（匿名读 200）。
已有主图时会自动改用非主图，可反复执行。

```bash
# 换端口 / 指定样品
API_BASE=http://127.0.0.1:3010 SAMPLE_ID=<uuid> scripts/verify-media-e2e.sh
```

## 脚本行为

| 子命令       | 行为                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `up`（默认） | 下载（仅首次）→ 启动 → 等 `/minio/health/live` → 建桶 → 开放匿名读 → 打印 env |
| `status`     | 进程 / 健康 / bucket 三项；未运行时退出码 3                                   |
| `down`       | 只停 PID 文件里、且命令行匹配本目录数据目录的进程（避免误杀同机其它 minio）   |
| `logs`       | `tail -f .dev-storage/minio.log`                                              |
| `env`        | 打印与 `.env` 一致的 `S3_*` / `MEDIA_*`                               |

固定版本（避免"latest"漂移）：`minio RELEASE.2025-07-23T15-54-02Z`、
`mc RELEASE.2025-07-21T05-28-08Z`。下载后按镜像站的 `.sha256sum` 校验；校验和缺失时
默认拒绝安装（`ALLOW_UNVERIFIED_DOWNLOAD=1` 才跳过，仅用于可信镜像站临时故障）。

支持 `linux` / `darwin` × `amd64` / `arm64`，二进制、数据、日志、`mc` 配置都在
`.dev-storage/`（已加入 `.gitignore`），不污染仓库与 `$HOME`。

## 与 docker compose 的关系

`minio` / `minio-init` 已放进 `media` profile：

```bash
# 日常开发：不需要对象存储时照旧，只起 PG / Redis
docker compose up -d

# 能拉镜像时：显式起对象存储
docker compose --profile media up -d minio minio-init

# 拉不到 Docker Hub 但有可用镜像站时：覆盖镜像地址
MINIO_IMAGE=registry.example.com/minio/minio:RELEASE.2025-07-23T15-54-02Z \
MC_IMAGE=registry.example.com/minio/mc:RELEASE.2025-07-21T05-28-08Z \
  docker compose --profile media up -d minio minio-init
```

默认 `docker compose up -d` 不会再尝试拉 minio 镜像，因此 PG/Redis 的开发流程
不受影响。`--profile media` 与脚本二选一即可，不要同时起（端口 9000/9001 冲突）。

## 环境变量契约（与 `.env` 一致）

| 变量                   | 本地值                  | 说明                                                              |
| ---------------------- | ----------------------- | ----------------------------------------------------------------- |
| `S3_ENDPOINT`          | `http://127.0.0.1:9000` | 脚本打印的是 127.0.0.1；API 默认 localhost                        |
| `S3_REGION`            | `us-east-1`             | MinIO 不校验地域                                                  |
| `S3_BUCKET`            | `weave-media`           | 脚本自动创建                                                      |
| `S3_ACCESS_KEY_ID`     | `weave-media`           | 同时作为 `MINIO_ROOT_USER`                                        |
| `S3_SECRET_ACCESS_KEY` | `weave-media-secret`    | 同时作为 `MINIO_ROOT_PASSWORD`                                    |
| `S3_FORCE_PATH_STYLE`  | `true`                  | MinIO 必须 path-style；COS 必须 false                             |
| `MEDIA_BASE_URL`       | 可留空                  | 留空发签名 URL；填 `http://localhost:9000/weave-media` 走匿名直链 |

生产/OIDC 模式会拒绝 dev 占位 S3 凭据（进程启动即失败），不会静默退回本地磁盘或 base64。

## 已实测结果（2026-11-14，本机：Docker Hub 不可达、无外部凭证）

- `scripts/dev-storage-up.sh`：下载并校验 105MB minio + 29MB mc，启动后
  `status` 显示 `运行中 pid=… / bucket 可访问：weave-media`。
- `scripts/verify-media-e2e.sh`（签名 URL 模式，未设 `MEDIA_BASE_URL`）：
  `presign 201 → PUT 200 → confirm 201 → GET /api/samples/:id 200，images 0→1`，
  `images[0].url` 带签名且取图 200、70 字节与源文件一致。
- 另以 `MEDIA_BASE_URL=http://127.0.0.1:9000/weave-media` 重启 API 复跑：
  返回的 `images[0].url` 为无签名直链，取图 200；同一样品 `images 1→2`。
- 桶匿名读独立复核：去掉签名参数直接 GET 对象，`200 / 70 bytes`。

## 排障

| 现象                                       | 处理                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `端口 9000 上已有其它 MinIO/S3 服务在响应` | 脚本拒绝接管非自己启动的进程；先停掉它，或 `MINIO_PORT=9100 MINIO_CONSOLE_PORT=9101`                 |
| 已有由本脚本启动的进程但健康检查失败       | `scripts/dev-storage-up.sh down` 后重跑 `up`                                                         |
| 下载 404 / 超时                            | 换镜像：`MINIO_DOWNLOAD_MIRRORS="https://dl.minio.org.cn"`；或把已下载二进制放进 `.dev-storage/bin/` |
| 校验和不匹配                               | 不要绕过；换镜像重试                                                                                 |
| 上传 403（签名 URL 正常但 PUT 失败）       | 检查本机时钟偏差（SigV4 对时间敏感）；`date -u` 与容器/服务端一致                                    |
| bucket 不可访问                            | `scripts/dev-storage-up.sh logs` 看启动日志；确认 `S3_*` 与启动时一致                                |
| 只改 `S3_ACCESS_KEY_ID` 后 `mc` 认证失败   | MinIO root 凭据在数据目录首次初始化后固定；改凭据需 `down` 并用新数据目录或接受旧凭据                |
