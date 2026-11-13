import "reflect-metadata";
import { createPlatformDb, resolvePlatformDatabaseUrl } from "@weave-order/control-db";
import {
  featureFlags,
  identitySettings,
  invoiceSettings,
  llmSettings,
  plans,
  planPrices,
  priceBooks,
  platformUsers,
  subscriptions,
  tenants,
  usageDaily,
} from "@weave-order/control-db";

/**
 * 控制面种子：平台人员、套餐、价格表 v1、开关、演示租户。
 * 幂等，可以重复执行；不触碰租户业务库。
 */
const USERS = [
  { subject: "owner", name: "演示 Owner", email: "owner@weaveorder.cn", role: "platform_owner" },
  {
    subject: "owner2",
    name: "演示 Owner（复核）",
    email: "owner2@weaveorder.cn",
    role: "platform_owner",
  },
  {
    subject: "finance",
    name: "演示财务",
    email: "finance@weaveorder.cn",
    role: "platform_finance",
  },
  { subject: "ops", name: "演示运维", email: "ops@weaveorder.cn", role: "platform_ops" },
  {
    subject: "support",
    name: "演示客服",
    email: "support@weaveorder.cn",
    role: "platform_support",
  },
  {
    subject: "readonly",
    name: "演示只读",
    email: "readonly@weaveorder.cn",
    role: "platform_readonly",
  },
] as const;

const PLANS = [
  {
    code: "TRIAL",
    name: "试用 Trial",
    tier: 0,
    seatMin: 1,
    seatMax: 3,
    agentActionsQuota: 100,
    storageGb: 20,
  },
  {
    code: "STARTER",
    name: "基础 Starter",
    tier: 1,
    seatMin: 3,
    seatMax: 10,
    agentActionsQuota: 1000,
    storageGb: 100,
  },
  {
    code: "PRO",
    name: "专业 Pro",
    tier: 2,
    seatMin: 10,
    seatMax: 50,
    agentActionsQuota: 5000,
    storageGb: 400,
  },
  {
    code: "ENTERPRISE",
    name: "旗舰 Enterprise",
    tier: 3,
    seatMin: 50,
    seatMax: 100000,
    agentActionsQuota: 50000,
    storageGb: 2000,
  },
] as const;

const PRICES = [
  { planCode: "TRIAL", monthlyPriceCents: 0, annualPriceCents: 0 },
  { planCode: "STARTER", monthlyPriceCents: 29900, annualPriceCents: 299000 },
  { planCode: "PRO", monthlyPriceCents: 49900, annualPriceCents: 499000 },
  { planCode: "ENTERPRISE", monthlyPriceCents: 0, annualPriceCents: 0 },
];

async function main(): Promise<void> {
  const { db, pool } = createPlatformDb(resolvePlatformDatabaseUrl());
  try {
    for (const user of USERS) {
      await db
        .insert(platformUsers)
        .values(user)
        .onConflictDoUpdate({
          target: platformUsers.subject,
          set: { name: user.name, email: user.email, role: user.role, status: "ACTIVE" },
        });
    }

    for (const plan of PLANS) {
      await db
        .insert(plans)
        .values({
          ...plan,
          features: {
            customer_portal: plan.tier >= 1,
            sso: plan.tier >= 2,
            custom_domain: plan.tier >= 2,
            print_agent: plan.tier >= 2,
          },
        })
        .onConflictDoUpdate({
          target: plans.code,
          set: {
            name: plan.name,
            tier: plan.tier,
            seatMin: plan.seatMin,
            seatMax: plan.seatMax,
            agentActionsQuota: plan.agentActionsQuota,
            storageGb: plan.storageGb,
          },
        });
    }

    const existingBooks = await db.select().from(priceBooks);
    let firstBook = existingBooks.find((book) => book.version === 1);
    if (!firstBook) {
      const rows = await db
        .insert(priceBooks)
        .values({
          version: 1,
          status: "ACTIVE",
          effectiveFrom: new Date(),
          activatedAt: new Date(),
          createdBy: "seed",
          notes: "初始价格表：Starter ¥299 / Pro ¥499 / 年付 10 个月价",
        })
        .returning();
      firstBook = rows[0];
      const bookId = firstBook?.id;
      if (bookId) {
        await db
          .insert(planPrices)
          .values(PRICES.map((price) => ({ ...price, priceBookId: bookId, currency: "CNY" })));
      }
    }

    await db.insert(invoiceSettings).values({ id: "default" }).onConflictDoNothing();
    await db.insert(identitySettings).values({ id: "default" }).onConflictDoNothing();
    await db
      .insert(llmSettings)
      .values({
        scope: "GLOBAL",
        provider: "litellm",
        baseUrl: process.env.LITELLM_BASE_URL ?? "http://localhost:4000",
        defaultModel: "deepseek-chat",
        dailyTokenBudget: 5_000_000,
        monthlyTokenBudget: 100_000_000,
        allowExternal: true,
        updatedBy: "seed",
      })
      .onConflictDoNothing();

    const FLAGS = [
      {
        key: "customer_portal",
        name: "客户门户",
        description: "报价链接与寄样进度",
        enabled: true,
        rolloutPercent: 100,
      },
      {
        key: "print_agent",
        name: "打印代理",
        description: "本地打印代理灰度",
        enabled: true,
        rolloutPercent: 20,
      },
      {
        key: "sso",
        name: "企业 SSO",
        description: "Pro 及以上可用",
        enabled: false,
        rolloutPercent: 0,
      },
    ];
    for (const flag of FLAGS) {
      await db.insert(featureFlags).values(flag).onConflictDoNothing();
    }

    const existing = await db.select({ id: tenants.id }).from(tenants).limit(1);
    const bookId = firstBook?.id;
    if (existing.length === 0 && bookId) {
      const now = new Date();
      const demoTenants = [
        {
          name: "青禾纺织",
          slug: "qinghe",
          planCode: "PRO",
          seats: 20,
          monthly: 44900,
          status: "ACTIVE" as const,
        },
        {
          name: "华瑞制衣",
          slug: "huarui",
          planCode: "STARTER",
          seats: 5,
          monthly: 19900,
          status: "TRIAL" as const,
        },
      ];
      for (const demo of demoTenants) {
        const tenantRows = await db
          .insert(tenants)
          .values({
            name: demo.name,
            slug: demo.slug,
            status: demo.status,
            region: "cn-east",
            contactName: `${demo.name} 王经理`,
            contactEmail: `contact@${demo.slug}.example.com`,
            trialStartedAt: new Date(now.getTime() - 5 * 24 * 3600 * 1000),
            convertedAt: demo.status === "ACTIVE" ? now : null,
          })
          .returning();
        const tenant = tenantRows[0];
        if (!tenant) continue;
        await db.insert(subscriptions).values({
          tenantId: tenant.id,
          planCode: demo.planCode,
          priceBookId: bookId,
          seats: demo.seats,
          billingCycle: "MONTHLY",
          status: demo.status === "TRIAL" ? "TRIAL" : "ACTIVE",
          periodStart: now,
          periodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
          trialEndsAt:
            demo.status === "TRIAL" ? new Date(now.getTime() + 9 * 24 * 3600 * 1000) : null,
          nextDueAt: new Date(
            now.getTime() + (demo.status === "TRIAL" ? 9 : 30) * 24 * 3600 * 1000,
          ),
          effectiveMonthlyCents: demo.monthly,
        });
        for (let day = 0; day < 20; day += 1) {
          const date = new Date(now.getTime() - day * 24 * 3600 * 1000);
          await db
            .insert(usageDaily)
            .values({
              tenantId: tenant.id,
              day: date.toISOString().slice(0, 10),
              agentActions: 80 + ((day * 37) % 160),
              storageGb: String(12 + day * 0.4),
              smsCount: 3 + (day % 5),
              llmInputTokens: 120_000 + day * 1200,
              llmOutputTokens: 40_000 + day * 600,
              llmCostCents: 1800 + day * 35,
            })
            .onConflictDoNothing();
        }
      }
    }

    console.log("✔ 控制面种子完成：平台人员 / 套餐 / 价格表 / 开关 / 演示租户");
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error("✖ 控制面种子失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
