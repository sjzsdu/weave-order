import { CLI_VERSION } from "./commands";
import { printLine } from "./output";

/** 面向人类与 agent 的同一份命令说明（agent 会把它当权威用法）。 */

export const USAGE = `织序 WeaveOrder CLI ${CLI_VERSION}

用法:
  weave <命令> [参数] [--json]

凭据:
  weave login                     设备码登录（浏览器确认，自动保存凭据）
  weave login --token <token>     直接导入已有 token（CI / agent 环境）
  weave login --no-browser        不自动打开浏览器，只打印确认链接
  weave logout                    清除本地凭据
  weave whoami                    当前账号与凭据作用域
  weave doctor                    检查服务连通性与凭据有效性

凭据管理:
  weave token list [--include-revoked]
  weave token create <名称> [--scope read,write,approve] [--days 90]
  weave token revoke <token-id|前缀>

业务数据:
  weave customers [--limit 20]
  weave samples [--limit 50]
  weave approvals                 待审批队列
  weave panorama                  业务全景（只读）
  weave audit [--limit 20]        审计流水

审批（需要 approve 作用域）:
  weave approve <id> --kind quote|sample_shipment [--note "备注"]
  weave reject  <id> --kind quote|sample_shipment [--note "原因"]

工具（智能体可调用）:
  weave tool                                 列出工具
  weave tool search-by-spec --query "棉 平纹" [--composition 棉] [--limit 10]
  weave tool search-by-image --file ./fabric.jpg [--top-k 5]
  weave tool get-customer-history --customer-id <uuid> [--limit 20]
  weave tool generate-quote-draft --payload '<json>'
  weave tool create-sample-shipment --payload '<json>'
  （任意工具都可用 --payload 传完整 JSON 入参）

agent 集成:
  weave skill print               输出 skill 全文（可手工粘贴）
  weave skill install             安装到 ~/.codex/skills/weave-order/SKILL.md
  weave skill install --target claude
  weave skill install --dir <目录> --force

全局参数:
  --server <url>    指定 API 地址（默认 WEAVE_SERVER 或 http://localhost:3000）
  --json            输出机器可读 JSON（agent 首选）
  -h, --help        显示帮助
  -v, --version     显示版本

环境变量:
  WEAVE_SERVER      API 地址
  WEAVE_TOKEN       直接提供凭据（优先于配置文件，适合 agent 注入）
  WEAVE_CONFIG_DIR  配置目录（默认 ~/.config/weave-order）

退出码:
  0 成功 / 1 失败 / 2 用法错误 / 3 凭据问题 / 4 网络不可达
`;

export function printHelp(topic?: string): void {
  const topics: Record<string, string> = {
    login: `weave login [--server <url>] [--token <token>] [--no-browser]

默认走设备码流程：CLI 申请一次性确认码 → 你在浏览器打开链接确认 →
CLI 拿到个人 token 并保存到 ~/.config/weave-order/config.json（0600）。
默认签发的凭据作用域是 read,write：可以读数据、生成草稿，但不能审批。
需要 CLI 审批时，用 weave token create <名称> --scope read,write,approve 另建一枚。`,
    token: `weave token list | create <名称> [--scope ...] [--days N] | revoke <id|前缀>

create 输出的明文 token 只显示一次；数据库只存哈希。
撤销立即生效，已发出的请求不会追溯。`,
    tool: `weave tool <名称> [--payload '<json>'] [快捷参数]

快捷参数只覆盖常用工具；其余参数组合用 --payload 传完整 JSON。
工具失败时返回 { ok: false, error: { code, message } }，退出码 1。`,
    skill: `weave skill print | install [--target codex|claude|generic] [--dir DIR] [--force]

把 skills/weave-order/SKILL.md 安装到 agent 的 skills 目录。
codex 默认路径：~/.codex/skills/weave-order/SKILL.md`,
    approve: `weave approve <id> --kind quote|sample_shipment [--note "..."]
weave reject  <id> --kind quote|sample_shipment [--note "..."]

需要带 approve 作用域的凭据。默认登录凭据没有该作用域：
设计上不让 agent 用登录凭据自己批准自己。`,
  };
  printLine(topics[topic ?? ""] ?? USAGE);
}
