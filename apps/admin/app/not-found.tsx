import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "页面不存在",
  robots: { index: false, follow: false },
};

/**
 * 全局 404：默认的 Next.js 英文页会让用户以为系统崩了。
 * 这里只给品牌、中文说明和几个确定能走通的出口，不暴露任何内部错误信息。
 */
export default function NotFound() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="card">
          <div className="login-brand">
            <img src="/brand/logo-mark.svg" alt="" width={44} height={44} />
            <div>
              <p className="login-brand__name">万鸟科技</p>
              <p className="login-brand__sub">WANNIAO TECHNOLOGY</p>
            </div>
          </div>

          <p className="tiny muted" style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>
            404 · 页面不存在
          </p>
          <h1>没有找到这个页面</h1>
          <p className="sub">
            地址可能输错了，或者这个页面已经改名、下线。系统本身是正常的，不需要重新登录。
          </p>

          <div className="btn-row" style={{ marginTop: 16 }}>
            <Link className="btn btn-primary" href="/">
              返回总览
            </Link>
            <Link className="btn" href="/tenants">
              去租户
            </Link>
          </div>

          <p className="login-foot">
            如果是从收藏夹或旧链接进来的，请改用侧栏菜单进入。 尚未登录或会话已过期？
            <Link href="/login">前往登录页</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
