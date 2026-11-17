"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * 登出入口统一走原生 POST 表单，而不是 <Link href="/auth/logout">。
 * 链接会被 Next 预取，一次预取就是一次真实的 GET 登出。
 */
export function LogoutForm({
  children,
  className,
  buttonClassName = "logout-button",
  buttonStyle,
  style,
}: {
  children: ReactNode;
  className?: string;
  buttonClassName?: string;
  buttonStyle?: CSSProperties;
  style?: CSSProperties;
}) {
  return (
    <form action="/auth/logout" method="post" className={className} style={{ margin: 0, ...style }}>
      <button type="submit" className={buttonClassName} style={buttonStyle}>
        {children}
      </button>
    </form>
  );
}
