import { createHash } from "node:crypto";
import { Pool } from "pg";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sampleTextEmbeddings, samples, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { createKernel } from "../src/kernel";
import type { Kernel, KernelContext } from "../src/kernel";
import {
  DashScopeTextEmbeddingProvider,
  LocalStubEmbeddingProvider,
} from "../src/platform/embedding";
import type { EmbeddingProvider } from "../src/platform/embedding";
import { sampleContentHash } from "../src/kernel/sample-index.service";
import { sampleEmbeddingText } from "../src/kernel/sample-embedding-text";

/**
 * S3 集成测试：pgvector 列 / HNSW 索引 / contentHash 跳过重算 / 失败即报错。
 *
 * 需要本地 PostgreSQL（docker compose up -d && pnpm db:migrate）。
 * 真实模型用例只在 DASHSCOPE_API_KEY 存在时运行（本机已实测有效），
 * 缺 key 时显式 skip 并写明原因，不伪装成通过。
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://weave:weave@localhost:5433/weave_order";
const SYSTEM: KernelContext = { actor: { type: "SYSTEM", id: "s3-it-bootstrap" } };
const HUMAN: KernelContext = { actor: { type: "HUMAN", id: "s3-it-human" } };

let probe: Pool | null = null;
let pool: Pool | null = null;
let db: Db | null = null;
let available = false;
const createdTenantIds: string[] = [];

beforeAll(async () => {
  probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500, max: 2 });
  try {
    const table = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('public.sample_text_embeddings') IS NOT NULL AS exists",
    );
    available = table.rows[0]?.exists === true;
    if (available) {
      const handle = createDb(DATABASE_URL);
      db = handle.db;
      pool = handle.pool;
    }
  } catch {
    available = false;
  } finally {
    await probe.end();
    probe = null;
  }
}, 30_000);

afterAll(async () => {
  if (db && createdTenantIds.length > 0) {
    await db
      .delete(sampleTextEmbeddings)
      .where(inArray(sampleTextEmbeddings.tenantId, createdTenantIds));
    await db.delete(samples).where(inArray(samples.tenantId, createdTenantIds));
    await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
  }
  await pool?.end();
}, 60_000);

/** 确定性 1024 维替身：只为计数与索引行为，不冒充语义模型。 */
class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "test-semantic-1024";
  readonly dimension = 1024;
  readonly semantic = true;
  readonly calls: string[] = [];

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embedTexts([text]);
    return vector!;
  }

  embedTexts(texts: string[]): Promise<number[][]> {
    this.calls.push(...texts);
    return Promise.resolve(
      texts.map((text) => {
        const digest = createHash("sha512").update(text).digest();
        return Array.from({ length: this.dimension }, (_, index) => {
          const byte = digest[index % digest.length] ?? 0;
          return ((byte / 255) * 2 - 1) / 10;
        });
      }),
    );
  }

  embedImage(): Promise<number[]> {
    return Promise.reject(new Error("测试替身不支持图像"));
  }
}

class FailingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "test-failing-1024";
  readonly dimension = 1024;
  readonly semantic = true;
  embedText(): Promise<number[]> {
    return Promise.reject(new Error("模拟上游 HTTP 500（fake provider）"));
  }
  embedTexts(): Promise<number[][]> {
    return Promise.reject(new Error("模拟上游 HTTP 500（fake provider）"));
  }
  embedImage(): Promise<number[]> {
    return Promise.reject(new Error("不支持图像"));
  }
}

async function isolatedKernel(embedder: EmbeddingProvider, tag: string): Promise<Kernel> {
  if (!db) throw new Error("数据库不可用");
  const owner = createKernel(db);
  const tenant = await owner.tenancy.createTenant(
    { slug: `s3-${tag}-${Date.now().toString(36)}`, name: `S3 ${tag}`, casdoorOrg: `s3-${tag}` },
    SYSTEM,
  );
  createdTenantIds.push(tenant.id);
  return createKernel(db, embedder, { tenantId: tenant.id });
}

describe("S3 向量索引（集成）", () => {
  it("contentHash 未变不重算；改名触发一次重算", async (ctx) => {
    if (!available) return ctx.skip();
    const embedder = new CountingEmbeddingProvider();
    const kernel = await isolatedKernel(embedder, "hash");

    const sample = await kernel.samples.create(
      { code: "S3-HASH-1", name: "高支棉 220g", composition: "100% 棉", unit: "meter" },
      HUMAN,
    );
    expect(embedder.calls).toHaveLength(1);
    const firstHash = sampleContentHash(
      sampleEmbeddingText({
        code: "S3-HASH-1",
        name: "高支棉 220g",
        composition: "100% 棉",
        weight: null,
      }),
    );

    // 重复确认：同一份文本不再调模型。
    expect(await kernel.sampleIndex.ensureIndexedSample(sample.id)).toBe("unchanged");
    expect(embedder.calls).toHaveLength(1);

    // 只改成本底线：文本没变，不重算。
    await kernel.samples.update(sample.id, { costFloor: { amount: 100, currency: "CNY" } }, HUMAN);
    expect(embedder.calls).toHaveLength(1);

    // 改名：必须重算，且 hash 变了。
    await kernel.samples.update(sample.id, { name: "高支棉 240g 精梳" }, HUMAN);
    expect(embedder.calls).toHaveLength(2);
    const stored = await db!
      .select({ contentHash: sampleTextEmbeddings.contentHash })
      .from(sampleTextEmbeddings)
      .where(inArray(sampleTextEmbeddings.sampleId, [sample.id]));
    expect(stored[0]?.contentHash).not.toBe(firstHash);

    // 全租户重算也跳过已是最新的行。
    const result = await kernel.sampleIndex.reindexTenant();
    expect(result.failures).toHaveLength(0);
    expect(result.indexed).toBe(0);
    expect(embedder.calls).toHaveLength(2);
  }, 30_000);

  it("模型失败 => 创建请求失败，样品与索引都不落库", async (ctx) => {
    if (!available) return ctx.skip();
    const kernel = await isolatedKernel(new FailingEmbeddingProvider(), "fail");
    const code = `S3-FAIL-${Date.now().toString(36)}`;
    await expect(
      kernel.samples.create({ code, name: "失败样品", unit: "meter" }, HUMAN),
    ).rejects.toThrow(/模拟上游 HTTP 500/);

    const rows = await db!
      .select({ id: samples.id })
      .from(samples)
      .where(inArray(samples.tenantId, [kernel.tenantId]));
    expect(rows).toHaveLength(0);
  }, 20_000);

  it("读路径只补缺失行：已就绪时搜索不再重算", async (ctx) => {
    if (!available) return ctx.skip();
    const embedder = new CountingEmbeddingProvider();
    const kernel = await isolatedKernel(embedder, "readpath");
    const first = await kernel.samples.create(
      { code: "S3-RP-1", name: "TC twill 240gsm", unit: "meter" },
      HUMAN,
    );
    await kernel.samples.create(
      { code: "S3-RP-2", name: "polyester chiffon printed", unit: "meter" },
      HUMAN,
    );
    expect(embedder.calls).toHaveLength(2);

    // 索引就绪：搜索只该为 query 调一次模型，不重算样品。
    await kernel.search.searchBySpec({ query: "涤棉斜纹 240 克", limit: 5 });
    expect(embedder.calls).toHaveLength(3);

    // 人为删掉一条索引行：下一次搜索只补这一条，而不是全量重算。
    await db!
      .delete(sampleTextEmbeddings)
      .where(inArray(sampleTextEmbeddings.sampleId, [first.id]));
    await kernel.search.searchBySpec({ query: "涤棉斜纹 240 克", limit: 5 });
    expect(embedder.calls).toHaveLength(5); // 补 1 条样品 + 1 次 query
    const restored = await db!
      .select({ id: sampleTextEmbeddings.id })
      .from(sampleTextEmbeddings)
      .where(inArray(sampleTextEmbeddings.sampleId, [first.id]));
    expect(restored).toHaveLength(1);
  }, 30_000);

  it("检索时模型失败 => 抛错（不会被当成「无结果」返回）", async (ctx) => {
    if (!available) return ctx.skip();
    const kernel = await isolatedKernel(new CountingEmbeddingProvider(), "searchfail");
    await kernel.samples.create({ code: "S3-SF-1", name: "TC twill 240gsm", unit: "meter" }, HUMAN);
    const failing = createKernel(db!, new FailingEmbeddingProvider(), {
      tenantId: kernel.tenantId,
    });
    await expect(
      failing.search.searchBySpec({ query: "涤棉斜纹 240 克", limit: 5 }),
    ).rejects.toThrow(/模拟上游 HTTP 500/);
  }, 20_000);

  it("local-stub 下不启用语义分支（哈希分数不当语义用）", async (ctx) => {
    if (!available) return ctx.skip();
    const kernel = await isolatedKernel(new LocalStubEmbeddingProvider(), "stub");
    await kernel.samples.create({ code: "S3-STUB-1", name: "涤纶雪纺", unit: "meter" }, HUMAN);
    const result = await kernel.search.searchBySpec({
      query: "polyester chiffon fabric",
      limit: 5,
    });
    expect(result.matches.every((match) => !match.matchedOn.includes("semantic"))).toBe(true);
    // local-stub 不写 pgvector 表（只走旧 real[] 兼容路径）。
    const rows = await db!
      .select({ id: sampleTextEmbeddings.id })
      .from(sampleTextEmbeddings)
      .where(inArray(sampleTextEmbeddings.tenantId, [kernel.tenantId]));
    expect(rows).toHaveLength(0);
  }, 20_000);
});

describe("S3 HNSW 索引", () => {
  it("1000 条时 p95 < 50ms；数据量上来后 EXPLAIN 自然走 hnsw 索引", async (ctx) => {
    if (!available || !pool || !db) return ctx.skip();
    const kernel = await isolatedKernel(new CountingEmbeddingProvider(), "bench");
    const tenantId = kernel.tenantId;
    const model = "test-semantic-1024";
    const queryVector = JSON.stringify(Array.from({ length: 1024 }, () => Math.random() - 0.5));
    const params = [tenantId, model, queryVector];
    const sql = `SELECT s.id FROM sample_text_embeddings e
       JOIN samples s ON s.id = e.sample_id
       WHERE e.tenant_id = $1 AND e.model = $2
       ORDER BY e.embedding <=> $3::vector
       LIMIT 20`;

    const insertSamples = async (count: number) => {
      // 直接批量造样品与随机向量：只测数据库检索路径，不调模型。
      await pool!.query(
        `INSERT INTO samples (tenant_id, code, name, unit)
         SELECT $1, 'S3-BENCH-' || gen_random_uuid(), '基准样品', 'meter'
         FROM generate_series(1, $2)`,
        [tenantId, count],
      );
      await pool!.query(
        `INSERT INTO sample_text_embeddings (tenant_id, sample_id, model, dimension, embedding, content_hash)
         SELECT $1, s.id, $2, 1024,
                (SELECT array_agg(random()::real) FROM generate_series(1, 1024))::vector,
                md5(s.id::text)
         FROM samples s
         LEFT JOIN sample_text_embeddings e ON e.sample_id = s.id AND e.model = $2
         WHERE s.tenant_id = $1 AND e.id IS NULL`,
        [tenantId, model],
      );
      await pool!.query("ANALYZE sample_text_embeddings");
    };

    const measure = async (runs: number) => {
      const timings: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const started = performance.now();
        await pool!.query(sql, params);
        timings.push(performance.now() - started);
      }
      timings.sort((left, right) => left - right);
      return timings[Math.floor(timings.length * 0.95) - 1] ?? timings.at(-1) ?? 0;
    };

    // ① 1000 条：planner 认为 Seq Scan + top-N sort 更便宜（成本模型正确，实测 ~5ms），
    //    这里只锁「远低于 50ms」的延迟目标，不强行要求索引。
    await insertSamples(1000);
    const p95At1000 = await measure(20);
    console.log(`1000 条样品：p95 = ${p95At1000.toFixed(2)}ms`);
    expect(p95At1000).toBeLessThan(50);

    // ② 5000 条：HNSW 的成本优势出现，planner 自然选择索引（无需 hint）。
    await insertSamples(4000);
    const explain = await pool.query<{ "QUERY PLAN": { Plan: unknown }[] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      params,
    );
    const plan = JSON.stringify(explain.rows[0]?.["QUERY PLAN"] ?? "");
    expect(plan).toContain("sample_text_embeddings_embedding_hnsw_idx");
    const p95At5000 = await measure(30);
    console.log(`5000 条样品：p95 = ${p95At5000.toFixed(2)}ms（走 HNSW）`);
    expect(p95At5000).toBeLessThan(50);
  }, 120_000);
});

describe("S3 真实语义检索（DashScope text-embedding-v3）", () => {
  const apiKey = process.env.DASHSCOPE_API_KEY ?? process.env.EMBEDDING_API_KEY;

  it("5 组同义/中英对照至少 4 组 top-3 命中", async (ctx) => {
    if (!available) return ctx.skip();
    if (!apiKey) {
      return ctx.skip("未设置 DASHSCOPE_API_KEY：真实语义用例无法运行（本机验收时已实跑）。");
    }
    const embedder = new DashScopeTextEmbeddingProvider({
      apiKey,
      dimension: 1024,
      maxAttempts: 3,
      retryBaseMs: 250,
    });
    const kernel = await isolatedKernel(embedder, "semantic");

    const pairs = [
      {
        query: "涤棉斜纹 240 克",
        name: "TC twill 240gsm",
        composition: "65% polyester 35% cotton",
      },
      {
        query: "100% 棉 高支 60 支",
        name: "100% cotton high-count 60s",
        composition: "100% cotton",
      },
      { query: "防水尼龙 塔丝隆", name: "waterproof nylon taslan", composition: "100% nylon" },
      { query: "涤纶雪纺 印花", name: "polyester chiffon printed", composition: "100% polyester" },
      {
        query: "弹力牛仔布 12 盎司",
        name: "stretch denim 12oz",
        composition: "98% cotton 2% spandex",
      },
    ];
    const decoys = [
      "真丝双绉 16 姆米",
      "羊毛呢 480g/m",
      "涤纶牛津布 600D",
      "亚麻平纹 200g",
      "锦纶塔夫绸 210T",
    ];

    for (const [index, pair] of pairs.entries()) {
      await kernel.samples.create(
        {
          code: `S3-SEM-${index + 1}`,
          name: pair.name,
          composition: pair.composition,
          weight: `${200 + index * 10}g/m2`,
          unit: "meter",
        },
        HUMAN,
      );
    }
    for (const [index, name] of decoys.entries()) {
      await kernel.samples.create({ code: `S3-DECOY-${index + 1}`, name, unit: "meter" }, HUMAN);
    }

    let hits = 0;
    const report: string[] = [];
    for (const pair of pairs) {
      const result = await kernel.search.searchBySpec({ query: pair.query, limit: 5 });
      const top3 = result.matches.slice(0, 3).map((match) => match.sample.name);
      const hit = top3.includes(pair.name);
      if (hit) hits += 1;
      const semantic = result.matches.filter((match) => match.matchedOn.includes("semantic"));
      for (const match of semantic) {
        expect(match.score).toBeGreaterThanOrEqual(0.5);
        expect(match.score).toBeLessThanOrEqual(1);
      }
      report.push(`${hit ? "✔" : "✘"} ${pair.query} -> ${pair.name} | top3: ${top3.join(" / ")}`);
    }
    console.log(report.join("\n"));
    expect(hits).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
