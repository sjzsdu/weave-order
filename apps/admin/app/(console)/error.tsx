"use client";

import { useEffect } from "react";

interface ConsoleErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * 控制台路由组的服务端错误边界。
 *
 * 没有它时，(console) 下任何 page 的 platformFetch 异常（401 会话失效、
 * 403 无权限、控制面 5xx、网络失败）都会冒泡到 Next.js 默认错误页，
 * 用户只看到 "Application error ... Digest: xxx"，既不知道发生了什么，
 * 也没有任何可操作出口。
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
          <h1>控制台暂时无法显示</h1>
          <p className="sub">
            加载本页所需的控制面数据失败了。常见原因：登录会话已过期、当前账号没有对应权限，或控制面接口暂时不可用。
          </p>

          <div className="alert alert-warn" style={{ marginTop: 12 }}>
            详细堆栈只写在服务端日志（容器 <span className="mono">weave-admin</span>
            ），排查时请提供下面的错误编号。
          </div>

          {error.digest ? (
            <p className="small muted" style={{ marginTop: 12 }}>
              错误编号（Digest）：<span className="mono">{error.digest}</span>
            </p>
          ) : null}

          <div className="btn-row" style={{ marginTop: 16 }}>
            <a className="btn btn-primary" href="/auth/logout">
              重新登录
            </a>
            <button className="btn" type="button" onClick={() => reset()}>
              重试
            </button>
          </div>

          <p className="login-foot">
            「重新登录」会清除本机会话并回到登录页；如果只是控制面短暂抖动，直接重试即可。
          </p>
        </div>
      </div>
    </div>
  );
}
