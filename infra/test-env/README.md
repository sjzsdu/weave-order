# 测试环境（`*.wnbgj.com`）

## 与生产的关系

同一份代码、同一个镜像 tag，只换 env / 库 / Redis / 对象存储 / Casdoor 用户池。

| 常量 | 生产 | 测试 |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production` |
| `AUTH_MODE` | `oidc` | `oidc` |
| `WEAVE_ENV` | 不设（或 `production`） | **`test`** |
| 库 / Redis / bucket | 生产实例 | 独立实例 |
| Casdoor | 真实客户 | 内部同事用户池 |

`WEAVE_ENV=test` 是唯一差异开关：只有它会放行 `pnpm demo:reset` 与 `/api/demo/scenes`。
生产不设，脚本入口直接拒绝，镜像里也没有可点击的演示入口。

## 首次部署

```bash
cp infra/test-env/.env.test.example .env.test
# 填入独立的库 / Redis / bucket / 密钥；确认 NODE_ENV/AUTH_MODE/WEAVE_ENV 不要改
docker compose --env-file .env.test -f infra/test-env/docker-compose.yml up -d migrate
docker compose --env-file .env.test -f infra/test-env/docker-compose.yml up -d api web quote
```

Casdoor 侧：在测试 Organization 下建内部用户（老板、销售、测试各一个），
角色只需映射到 `memberships.role`，不要在应用里另存密码。

## 重置演示数据

```bash
docker compose --env-file .env.test -f infra/test-env/docker-compose.yml \
  run --rm demo-reset
```

脚本会：清对象存储 `tenant/<id>/` → `DROP SCHEMA public, drizzle` → migrate →
seed → `demo:scenes` → 清 `weave:session:*`。连跑两次结果一致；浏览器旧会话被清掉，
不会出现「重置完白屏」。

演示入口（同一份 `data/demo-scenes.json`）：

- `/today?scene=approval-pending`
- `/today?scene=sample-shipment-pending`

## 生产保护

在生产环境执行同一命令会被拒绝：

```text
✖ 拒绝执行 demo:reset：当前是生产环境（NODE_ENV=production 或 AUTH_MODE=oidc），且未设置 WEAVE_ENV=test。
```

退出码非 0。`WEAVE_ENV=test + AUTH_MODE=dev` 也会在 api 启动期报错，
避免「可重置」与生产门控同时成立。
