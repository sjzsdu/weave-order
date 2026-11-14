/**
 * 支持联系方式：统一定义在这里，页面不要再写死邮箱。
 *
 * 部署时通过 `NEXT_PUBLIC_SUPPORT_EMAIL` 配置；没配就不显示邮箱，
 * 只留「联系公司管理员」，避免把占位地址发给真实用户。
 */
export const SUPPORT_EMAIL = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "").trim();

/** 点一下就能发邮件；未配置邮箱时返回 null，调用方据此隐藏入口。 */
export function SupportMailto({ className, label }: { className?: string; label?: string }) {
  if (!SUPPORT_EMAIL) return null;
  return (
    <a href={`mailto:${SUPPORT_EMAIL}`} className={className}>
      {label ?? SUPPORT_EMAIL}
    </a>
  );
}
