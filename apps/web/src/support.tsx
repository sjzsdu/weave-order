"use client";

import { useRuntimeConfig } from "./runtime-config";

/**
 * 支持联系方式：统一定义在这里，页面不要再写死邮箱。
 *
 * 邮箱由部署环境的 `SUPPORT_EMAIL` 决定（经 `/config.js` 在运行时下发），
 * 不写进客户端包，所以换邮箱只要改容器环境变量并重启。
 * 没配就不显示邮箱，只留「联系公司管理员」，避免把占位地址发给真实用户。
 */
export function SupportMailto({ className, label }: { className?: string; label?: string }) {
  const { supportEmail } = useRuntimeConfig();
  if (!supportEmail) return null;
  return (
    <a href={`mailto:${supportEmail}`} className={className}>
      {label ?? supportEmail}
    </a>
  );
}
