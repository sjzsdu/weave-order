/**
 * 登录失败文案。
 *
 * 失败可能来自我们自己的回调，也可能来自 Casdoor 的 `error_description`。
 * 后者会带内部组织名（`weave-order/...`）与英文错误码，直接展示既像骂人又泄露结构；
 * 这里统一收成用户能行动的三句话，其余异常不再原样透出。
 */
export function friendlyLoginError(raw: string | null | undefined): string {
  const text = raw?.trim() ?? "";
  if (text.length === 0) return "";

  if (/不存在|not\s*found|does\s*not\s*exist|no\s*such\s*user/i.test(text)) {
    return "账号不存在或还没开通。请检查用户名是否输错，或让公司管理员邀请你。";
  }
  if (/密码|password|credential|invalid\s*login|bad\s*credential/i.test(text)) {
    return "账号或密码不正确。请重试一次，忘记密码可以点下方「忘记密码」。";
  }
  if (/HTTP\s*\d{3}|令牌|request\s*id|invalid_grant|error_description|weave-order/i.test(text)) {
    return "登录没有完成，请稍后再试；如果一直失败，请联系公司管理员。";
  }
  // 我们自己产生的中文说明（缺少授权码 / state 校验失败等）可以直接给用户看。
  return text.length <= 120 ? text : "登录没有完成，请稍后再试。";
}
