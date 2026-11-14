# 样品缩略图与存量媒体治理（WAN-125）

图墙首屏不再加载原图：`confirm` 成功后服务端用 `sharp` 派生两档 webp 并持久化到对象存储。

## 为什么不走 CDN 参数 / 客户端压缩

- `MEDIA_BASE_URL` 未配置时，`?w=320` 既不会缩图，还会破坏签名 URL；本地 MinIO 也没有图片处理。
- 客户端压缩只在上传前生效，管不了历史存量，也管不了别人用 presign 直传上来的原图。
- 所以缩略图必须**落盘**：稳定 key、可缓存、本地与生产同一套行为。

## 契约

| 项目 | 规则 |
| --- | --- |
| key | `tenant/<tenantId>/samples/<sampleId>/thumbs/<imageId>_320.webp`（图墙）与 `_640.webp`（详情抽屉） |
| DB | 只存 key：`thumb_320_key` / `thumb_640_key`；不存 URL |
| 状态 | `thumb_status = pending \| ready \| failed` + `thumb_error`（与 `index_status` 同一形态） |
| 失败 | 接口回退原图地址，但 `thumbStatus=failed` 必须显式标注，不静默假装有缩略图 |
| 读模型 | `thumbUrl`（就绪时是 `_320`，否则原图）、`detailUrl`（`_640`，未就绪为 null）、`thumbStatus`、`thumbError` |

派生在 `POST /api/media/confirm` 内同步完成（单图约 200ms，本地 CPU），失败不阻塞上传。
`create/update` 走 `imageKeys` 的路径也会补齐。

## 存量治理

```bash
# 干跑：读对象、算收益，但不写库、不写桶、不删对象
pnpm --filter @weave-order/api maintain:media -- --dry-run

# 全量：补派生 + 超大原图重编码（>2MB）+ 孤儿对象回收
pnpm --filter @weave-order/api maintain:media

# 只补缩略图 / 指定租户 / 调整阈值与保护期
pnpm --filter @weave-order/api maintain:media -- --skip-compress --skip-orphans
pnpm --filter @weave-order/api maintain:media -- --tenant=<uuid>
pnpm --filter @weave-order/api maintain:media -- --max-original-bytes=2097152 --grace-hours=24
```

三个动作都幂等：

- 补派生只处理 `thumb_status != ready`；
- 重编码只处理 `byte_size > 阈值 AND reencoded_at IS NULL`，写 `original_byte_size` 记录压缩前体积；
  **原 key 不变、覆盖写**（本任务不做图片版本管理），重编码后格式与扩展名保持一致；
- 孤儿只删 `tenant/<tid>/samples/` 下、未被 `object_key` / 两档缩略图引用、且超过保护期的对象。
  保护期内的对象视为「刚 PUT、还没 confirm」，不删；`receipts/` 与 `uploads/` 不在扫描范围。

## 验收

```bash
scripts/dev-storage-up.sh                     # 本地 MinIO
pnpm db:migrate
pnpm --filter @weave-order/api verify:thumbnails -- --count=50
```

实测（本地 MinIO，50 张 2400px JPEG，单张 1302 KB）：

| 口径 | 合计 | 平均/张 |
| --- | --- | --- |
| 改前（图墙拉原图） | 63.58 MB | 1302.2 KB |
| 改后（`_320.webp`） | 1.14 MB | 23.4 KB |
| 降幅 | **98.2%**（节省 62.44 MB） | |

首屏 50/50 命中 `_320.webp`；详情抽屉 `_640.webp` 合计 4.76 MB。

用例覆盖（`apps/api/test/thumbnails.test.ts`、`thumbnails.integration.test.ts`）：
key 规则、成功派生两档、失败回退标注、幂等重跑 / 强制重算、存量补派生干跑、
孤儿回收（保护期 / 引用保留 / 前缀隔离）、超大原图重编码幂等。
