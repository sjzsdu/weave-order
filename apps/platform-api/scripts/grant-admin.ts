import { eq } from "drizzle-orm";
import {
  createPlatformDb,
  resolvePlatformDatabaseUrl,
  platformUsers,
} from "@weave-order/control-db";
import type { PlatformRole } from "@weave-order/schema";

/**
 * 平台管理员名册：查看 / 授予 / 停用。
 *
 * 控制台没有「注册」，登录是 Casdoor OIDC：Casdoor 负责账号与密码，
 * 这里只维护「哪些 Casdoor 账号可以进平台、是什么角色」。
 *
 *   pnpm --filter @weave-order/platform-api admin:grant -- --list
 *   pnpm --filter @weave-order/platform-api admin:grant -- \
 *     --sub <Casdoor 用户 sub> --email boss@example.com --name 孙巨中 --role platform_owner
 *   pnpm --filter @weave-order/platform-api admin:grant -- --sub <sub> --disable
 */

const ROLES: PlatformRole[] = [
  "platform_owner",
  "platform_finance",
  "platform_support",
  "platform_ops",
  "platform_readonly",
];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const { db, pool } = createPlatformDb(resolvePlatformDatabaseUrl());
  try {
    if (has("list") || process.argv.length <= 2) {
      const rows = await db.select().from(platformUsers);
      if (rows.length === 0) {
        console.log("名册为空：还没有任何平台账号。用 --sub/--email/--role 添加一个。");
      }
      for (const row of rows) {
        console.log(
          `${row.status === "ACTIVE" ? "✓" : "·"} ${row.role.padEnd(18)} ${row.subject.padEnd(24)} ${row.email} (${row.name})`,
        );
      }
      return;
    }

    const sub = arg("sub")?.trim();
    if (!sub) throw new Error("缺少 --sub（Casdoor 用户的 sub，不是邮箱）");

    if (has("disable")) {
      const updated = await db
        .update(platformUsers)
        .set({ status: "DISABLED" })
        .where(eq(platformUsers.subject, sub))
        .returning();
      if (updated.length === 0) throw new Error(`名册里没有 ${sub}`);
      console.log(`已停用：${sub}`);
      return;
    }

    const email = arg("email")?.trim();
    const name = arg("name")?.trim();
    const role = arg("role") as PlatformRole | undefined;
    if (!email) throw new Error("缺少 --email");
    if (!role || !ROLES.includes(role)) {
      throw new Error(`--role 必须是：${ROLES.join(" / ")}`);
    }

    const rows = await db
      .insert(platformUsers)
      .values({
        subject: sub,
        email,
        name: name ?? email,
        role,
        status: "ACTIVE",
        // 平台端一律要求 MFA，由 Casdoor 应用 weave-platform 强制。
        mfaEnforced: true,
      })
      .onConflictDoUpdate({
        target: platformUsers.subject,
        set: { email, name: name ?? email, role, status: "ACTIVE" },
      })
      .returning();
    const row = rows[0];
    console.log(`已授予：${row?.subject} → ${row?.role}（${row?.email}）`);
    console.log("现在可以用这个 Casdoor 账号登录平台管理后台了。");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
