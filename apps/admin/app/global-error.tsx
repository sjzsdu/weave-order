"use client";

import { useEffect } from "react";
import { LogoutForm } from "@/src/logout-form";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/** 根 layout 级兜底：必须自带 html/body，且不依赖 globals.css 是否加载成功。 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("[admin] 应用级渲染失败", error);
  }, [error]);

  const actionStyle = {
    padding: "9px 16px",
    borderRadius: 8,
    border: "1px solid #cdd6e0",
    background: "#fff",
    color: "#17212e",
    fontSize: 14,
    cursor: "pointer",
    textDecoration: "none",
  } as const;

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          padding: 48,
          background: "#f6f7f9",
          color: "#17212e",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            margin: "0 auto",
            background: "#fff",
            border: "1px solid #dde3ea",
            borderRadius: 12,
            padding: 28,
          }}
        >
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>平台管理端暂时不可用</h1>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: "#53627a" }}>
            页面在服务端渲染时发生异常。详细堆栈已写入 weave-admin
            容器日志，请把下面的错误编号一并提供给运维。
          </p>
          {error.digest ? (
            <p style={{ fontSize: 13 }}>
              错误编号（Digest）：<code>{error.digest}</code>
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <LogoutForm buttonStyle={actionStyle}>重新登录</LogoutForm>
            <button type="button" onClick={() => reset()} style={actionStyle}>
              重试
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
