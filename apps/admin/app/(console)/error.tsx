"use client";

import Link from "next/link";
import { useEffect } from "react";

interface ConsoleErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * 控制台路由组的服务端错误边界（兜底）。
 *
 * 会话失效（401）与无权限（403）已在 (console)/layout.tsx 分流到
 * 登录页 / no-access 页；这里主要接住控制面 5xx、网络抖动等真正的渲染异常。
 *
 * 关键：不再把「重新登录」当成首要操作。过去无论什么错误，最醒目的按钮都是
 * 指向 /auth/logout 的「重新登录」，用户点一下就被清 cookie 登出——
 * 这正是「点菜单被登出」的体验来源之一。现在「重新登录」降级为次要入口，
 * 且改用 /login（不主动清 cookie），真正需要清会话时由登录流程覆盖 cookie。
 */
export default function ConsoleError({ error, reset }: ConsoleErrorProps) {
  useEffect(() => {
    console.error("[admin] 控制台页面渲染失败", error);
  }, [error]);

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="card">
          <p className="tiny muted" style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>
            织序 · 内部管理
          </p>
          <h1>本页暂时无法显示</h1>
          <p className="sub">
            加载这一页时出错了。多数情况是控制面接口暂时不可用，稍后重试即可；
            这不代表你已退出登录。
          </p>

          <div className="alert alert-warn" style={{ marginTop: 12 }}>
            如果你是第一次打开这个菜单就看到本页，可能是账号权限问题（而非登录问题）——
            这种情况下重新登录不会有帮助，请联系平台管理员核对人员名册。
          </div>

          {error.digest ? (
            <p className="small muted" style={{ marginTop: 12 }}>
              错误编号（Digest）：<span className="mono">{error.digest}</span>
            </p>
          ) : null}

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" type="button" onClick={() => reset()}>
              重试
            </button>
            <Link className="btn" href="/">
              返回总览
            </Link>
          </div>

          <p className="login-foot">
            确认是会话问题才需要重新登录：
            <Link href="/login">前往登录页</Link>
            （不会主动清除当前会话，重新登录成功后会覆盖）。
          </p>
        </div>
      </div>
    </div>
  );
}
