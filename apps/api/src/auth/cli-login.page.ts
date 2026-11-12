/**
 * CLI 设备登录的浏览器确认页。
 *
 * 为什么由 API 直接出页面：这一步是「人类确认 CLI 身份」，不依赖租户端页面的
 * 登录态；接入 Casdoor 后，这个页面会换成带 OIDC 会话的租户端路由，
 * 表单字段 `email` 也会被会话身份替代，接口契约不变。
 */

export interface CliLoginPageInput {
  userCode?: string;
  error?: string;
  notice?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:#f7f6f3;color:#1d1d1b}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e6e2da;border-radius:16px;
  padding:28px 26px;box-shadow:0 10px 30px rgba(30,25,15,.06)}
.brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8a6a3b}
h1{margin:10px 0 6px;font-size:22px;line-height:1.35}
p.sub{margin:0 0 20px;color:#6b6459;font-size:14px;line-height:1.6}
label{display:block;font-size:13px;color:#4a453d;margin:14px 0 6px}
input[type=text],input[type=email]{width:100%;padding:11px 12px;border:1px solid #d9d3c8;border-radius:10px;
  font-size:15px;background:#fdfcf9}
input:focus{outline:2px solid #b98b4a;outline-offset:1px;border-color:#b98b4a}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;font-size:16px}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:16px;font-size:13px;color:#4a453d}
.check input{margin-top:2px}
.actions{display:flex;gap:10px;margin-top:22px}
button{flex:1;padding:12px 14px;border-radius:10px;border:1px solid transparent;font-size:15px;cursor:pointer}
.primary{background:#1d1d1b;color:#fff}
.ghost{background:#fff;border-color:#d9d3c8;color:#4a453d}
.error{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:#fdf1ef;border:1px solid #f2c7bf;
  color:#a3392a;font-size:13px}
.notice{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:#f0f6f0;border:1px solid #c9e0c9;
  color:#2f6b33;font-size:13px}
.hint{margin-top:18px;font-size:12px;color:#8a8378;line-height:1.6}
code{background:#f4f1ea;border-radius:4px;padding:1px 5px;font-size:12px}
`;

export function renderCliLoginPage(input: CliLoginPageInput): string {
  const userCode = input.userCode ?? "";
  const codeField = userCode
    ? `<input type="hidden" name="userCode" value="${escapeHtml(userCode)}" />
       <label>确认码</label>
       <input class="code" type="text" value="${escapeHtml(userCode)}" readonly />`
    : `<label for="userCode">确认码</label>
       <input class="code" id="userCode" name="userCode" type="text" placeholder="ABCD-EFGH"
              autocomplete="one-time-code" required />`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>织序 WeaveOrder · CLI 登录确认</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
  <p class="brand">织序 WeaveOrder</p>
  <h1>确认 CLI 登录</h1>
  <p class="sub">一台命令行工具正在申请访问你的织序账号。确认后会签发一枚个人 API token，
  它只能看到你有权限的数据，并且可以随时撤销。</p>
  ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
  ${input.notice ? `<p class="notice">${escapeHtml(input.notice)}</p>` : ""}
  <form method="post" action="/cli-login">
    ${codeField}
    <label for="email">你的邮箱</label>
    <input id="email" name="email" type="email" placeholder="you@company.com" required />
    <label for="name">称呼（可选）</label>
    <input id="name" name="name" type="text" placeholder="张三" />
    <label class="check">
      <input type="checkbox" name="allowApprove" value="1" />
      <span>允许这台 CLI 代我审批（approve 作用域）。<br />
      不确定就不要勾选：默认只能读取和生成草稿，审批仍需回到网页。</span>
    </label>
    <div class="actions">
      <button class="ghost" type="submit" name="decision" value="deny">拒绝</button>
      <button class="primary" type="submit" name="decision" value="approve">批准登录</button>
    </div>
  </form>
  <p class="hint">确认码 10 分钟内有效，只能使用一次。若不是你本人发起，请直接关闭本页，并
  在 <code>weave token list</code> 里检查是否有陌生凭据。</p>
</main>
</body>
</html>`;
}

export function renderCliLoginResult(input: {
  approved: boolean;
  email: string;
  userCode: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>织序 WeaveOrder · CLI 登录${input.approved ? "已批准" : "已拒绝"}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
  <p class="brand">织序 WeaveOrder</p>
  <h1>${input.approved ? "已批准 CLI 登录" : "已拒绝 CLI 登录"}</h1>
  <p class="sub">
    ${
      input.approved
        ? `账号 <strong>${escapeHtml(input.email)}</strong> 已授权确认码
           <code>${escapeHtml(input.userCode)}</code>。回到终端，CLI 会自动完成登录。`
        : `确认码 <code>${escapeHtml(input.userCode)}</code> 已被拒绝，CLI 不会获得任何凭据。`
    }
  </p>
  <p class="hint">可以关闭本页。凭据管理：<code>weave token list</code> /
  <code>weave token revoke &lt;id&gt;</code>。</p>
</main>
</body>
</html>`;
}
