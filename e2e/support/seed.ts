import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { API_URL, ARTIFACTS_DIR, AUTH, REPO_ROOT } from "./env";

/**
 * 验收数据种子：只通过 HTTP API 写入（不直连数据库），因此这套种子本身
 * 也在验证 presign → PUT → confirm → 后台索引这条真实链路。
 *
 * 幂等：样品 code 由「fixture 内容哈希」派生，同一次 fixture 重复跑不会长出新样品；
 * 换了 fixture 才会出现新 code（旧的自测样品留在库里，不影响断言）。
 */

const FIXTURES_DIR = path.join(ARTIFACTS_DIR, "..", "fixtures");
const PRIMARY_FILE = path.join(FIXTURES_DIR, "fabric-primary.jpg");
const ALT_FILE = path.join(FIXTURES_DIR, "fabric-alt.jpg");
const SEED_FILE = path.join(ARTIFACTS_DIR, "seed.json");

const ALLOWED = "image/jpeg";

interface ApiImage {
  id: string;
  url: string;
  /** WAN-125：服务端派生的 `_320.webp`；未就绪时回退原图，必须同时看 thumbStatus。 */
  thumbUrl: string | null;
  detailUrl?: string | null;
  thumbStatus: "pending" | "ready" | "failed";
  thumbError?: string | null;
  isPrimary: boolean;
  indexStatus: string;
  indexError?: string | null;
}

interface ApiSample {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  costFloor: { amount: number; currency: string } | null;
  images: ApiImage[];
}

export interface SeedSample extends ApiSample {
  /** 这个样品在种子里的角色，specs 用它挑卡片。 */
  role: "fabric" | "carousel";
}

export interface SeedManifest {
  fixture: string;
  altFixture: string;
  /** 多租户账号必须先选公司：后续请求带 `Cookie: weave_sid=<sid>`。 */
  ownerSid: string | null;
  salesSid: string | null;
  /** 可直接作为 `Authorization: Bearer <credential>` 的会话令牌（多租户必需）。 */
  ownerCredential: string;
  salesCredential: string;
  tenantId: string;
  /** WAN-136：由 persona 目录驱动的夹具，供角色切换与 TEAM 数据范围断言。 */
  persona: PersonaFixture;
  /** 10 个样品共用同一张图：top-5 断言不依赖真实模型也有 5 条候选，同时撑满 5 列两行。 */
  fabricSamples: SeedSample[];
  carouselSample: SeedSample;
  /** 共用图样品的 code 集合，供「top-5 必须包含它们」断言。 */
  sharedImageCodes: string[];
}

export interface PersonaFixture {
  tenantId: string;
  customerCode: string;
  customerName: string;
  salesSubject: string;
  managerSubject: string;
  salesTeamId: string | null;
  managerTeamId: string | null;
}

/** 选中的公司会话；多租户账号没有它时所有业务请求都是 401。 */
let ownerCredential: string = AUTH.owner;

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ownerCredential}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${pathname} → HTTP ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * 选公司：本地/共享库里 `dev:demo` 可能属于多个租户（另一套 UI 演示租户），
 * 此时 Bearer 本身不足以定位租户，必须走一次 `/api/auth/switch` 换 sid。
 * 优先选 slug=default（种子数据所在租户），否则取第一个 available。
 */
async function establishSession(
  token: string,
): Promise<{ sid: string | null; credential: string; tenantId: string }> {
  const headers = { Authorization: `Bearer ${token}` };
  const listResponse = await fetch(`${API_URL}/api/auth/tenants`, { headers });
  if (!listResponse.ok) {
    throw new Error(`GET /api/auth/tenants → HTTP ${listResponse.status}`);
  }
  const body = (await listResponse.json()) as {
    status?: string;
    tenant?: { id: string };
    tenants?: {
      tenantId: string;
      slug: string;
      available: boolean;
      membershipStatus: string;
    }[];
  };
  const choices = (body.tenants ?? []).filter(
    (choice) => choice.available && choice.membershipStatus === "ACTIVE",
  );
  const target = choices.find((choice) => choice.slug === "default") ?? choices[0];
  const tenantId = target?.tenantId ?? body.tenant?.id;
  if (!tenantId) throw new Error("账号没有可用公司，无法建立 E2E 会话");
  if (body.status !== "MULTI_TENANT") return { sid: null, credential: token, tenantId };
  const switchResponse = await fetch(`${API_URL}/api/auth/switch`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
  if (!switchResponse.ok) {
    throw new Error(`POST /api/auth/switch → HTTP ${switchResponse.status}`);
  }
  const cookie = switchResponse.headers
    .getSetCookie()
    .find((value) => value.startsWith("weave_sid="));
  const sid = cookie?.split(";")[0]?.slice("weave_sid=".length) ?? null;
  if (!sid) throw new Error("switch 没有返回 weave_sid");
  // 业务 API 用 `session:<sid>` 作为 Bearer，避免在跨域 H5 里依赖 Cookie。
  return { sid, credential: `session:${sid}`, tenantId };
}

async function findByCode(code: string): Promise<ApiSample | null> {
  const page = await api<{ samples: ApiSample[] }>(
    `/api/samples?query=${encodeURIComponent(code)}&status=ALL&limit=50`,
  );
  return page.samples.find((sample) => sample.code === code) ?? null;
}

async function createSample(input: {
  code: string;
  name: string;
  composition: string;
  weight: string;
  costFloor?: { amount: number; currency: "CNY" };
}): Promise<ApiSample> {
  const created = await api<{ sample: ApiSample }>("/api/samples", {
    method: "POST",
    body: JSON.stringify({ ...input, unit: "meter", status: "ACTIVE" }),
  });
  return created.sample;
}

/** 直传一张图并挂到样品上；sortOrder 由调用方指定（用来构造「插入顺序≠展示顺序」）。 */
async function uploadImage(
  sampleId: string,
  bytes: Buffer,
  options: { sortOrder: number; isPrimary: boolean },
): Promise<void> {
  const presign = await api<{
    uploadUrl: string;
    headers: Record<string, string>;
    objectKey: string;
  }>("/api/media/presign", {
    method: "POST",
    body: JSON.stringify({
      mimeType: ALLOWED,
      byteSize: bytes.length,
      sampleId,
      variant: "primary",
    }),
  });
  const put = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { ...presign.headers, "Content-Type": ALLOWED },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`PUT 图片失败：HTTP ${put.status}`);
  await api("/api/media/confirm", {
    method: "POST",
    body: JSON.stringify({
      objectKey: presign.objectKey,
      sortOrder: options.sortOrder,
      isPrimary: options.isPrimary,
    }),
  });
}

let backfillAttempted = false;

/**
 * WAN-125（main）之前的存量图没有 `_320.webp`：新分支第一次跑 E2E 时
 * 那些样品会一直停在 `thumbStatus=pending`。用仓库自带的治理 CLI 补一次，
 * 而不是改断言把「原图冒充缩略图」当成正常。
 */
function backfillLegacyThumbs(tenantId: string): void {
  if (backfillAttempted) return;
  backfillAttempted = true;
  console.log("[e2e] 检测到缩略图未派生（WAN-125 之前的存量图），先补派生一次…");
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@weave-order/api",
      "maintain:media",
      "--",
      `--tenant=${tenantId}`,
      "--skip-compress",
      "--skip-orphans",
    ],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(`缩略图补派生失败（exit ${result.status ?? "signal"}）`);
  }
}

async function waitIndexed(sampleId: string, timeoutMs = 90_000): Promise<ApiSample> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last: ApiSample | null = null;
  while (Date.now() < deadline) {
    const current = await api<{ sample: ApiSample }>(`/api/samples/${sampleId}`).then(
      (r) => r.sample,
    );
    last = current;
    const failed = current.images.find((image) => image.indexStatus === "failed");
    if (failed) {
      throw new Error(`样品图索引失败：${failed.indexError ?? "unknown"}`);
    }
    const indexReady =
      current.images.length > 0 && current.images.every((image) => image.indexStatus === "ready");
    const thumbsReady =
      current.images.length > 0 &&
      current.images.every((image) => image.thumbStatus === "ready" && image.thumbUrl !== null);
    if (indexReady && thumbsReady) return current;
    // 存量图不会自己派生：等 5s 仍 pending 就调一次治理 CLI。
    if (!thumbsReady && Date.now() - startedAt > 5_000) {
      backfillLegacyThumbs(current.tenantId);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `等待图片就绪超时：index=${last?.images.map((image) => image.indexStatus).join(",") ?? "none"} ` +
      `thumb=${last?.images.map((image) => image.thumbStatus).join(",") ?? "none"}`,
  );
}

/**
 * persona 夹具：7 个成员 + 一条业务员名下客户。
 *
 * 走 api workspace 的脚本而不是 HTTP：客户创建没有公开端点（内核是唯一写入口），
 * 而脚本本身复用 `ensureDemoIdentity` 与 persona 目录，避免 e2e 另抄一份角色清单。
 */
function ensurePersonaFixture(): PersonaFixture {
  const result = spawnSync("pnpm", ["--filter", "@weave-order/api", "seed:persona", "--silent"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `persona 夹具失败（exit ${result.status ?? "signal"}）：${result.stderr || result.stdout}`,
    );
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error("persona 夹具没有输出 JSON");
  return JSON.parse(line) as PersonaFixture;
}

export async function ensureSeed(): Promise<SeedManifest> {
  const persona = ensurePersonaFixture();
  const owner = await establishSession(AUTH.owner);
  ownerCredential = owner.credential;
  const sales = await establishSession(AUTH.sales);
  const [primary, alt] = await Promise.all([readFile(PRIMARY_FILE), readFile(ALT_FILE)]);
  const sha = createHash("sha256").update(primary).digest("hex").slice(0, 8);

  const fabricSamples: SeedSample[] = [];
  for (let index = 1; index <= 10; index += 1) {
    const code = `E2E-FAB-${sha}-${String(index).padStart(2, "0")}`;
    let sample = await findByCode(code);
    if (!sample) {
      sample = await createSample({
        code,
        name: `E2E 样品 ${String(index).padStart(2, "0")}`,
        composition: "100% 棉 · E2E",
        weight: "220g/m2",
        // 成本底线只给 01，详情页按角色裁剪的断言用它。
        ...(index === 1 ? { costFloor: { amount: 1200, currency: "CNY" as const } } : {}),
      });
    }
    if (sample.images.length === 0) {
      await uploadImage(sample.id, primary, { sortOrder: 0, isPrimary: true });
    }
    fabricSamples.push({ ...(await waitIndexed(sample.id)), role: "fabric" });
  }

  // 轮播样品：先传 sortOrder=2 的主图，再传 sortOrder=1 的另一张。
  // 若按 sortOrder 排序，展示顺序是 [sort1, sort2]；按插入顺序则会相反。
  // （不能在已有主图时再 confirm isPrimary=true：服务端明确要求先取消原主图。）
  const carouselCode = `E2E-CAR-${sha}-01`;
  let carousel = await findByCode(carouselCode);
  if (!carousel) {
    carousel = await createSample({
      code: carouselCode,
      name: "E2E 双图样品",
      composition: "55% 麻 45% 棉 · E2E",
      weight: "180g/m2",
    });
  }
  if (carousel.images.length < 2) {
    if (carousel.images.length === 0) {
      await uploadImage(carousel.id, primary, { sortOrder: 2, isPrimary: false });
      await uploadImage(carousel.id, alt, { sortOrder: 1, isPrimary: false });
    } else {
      // 上一轮只传了一张（中断）：补齐另一张，保持「按 sortOrder 排」的语义。
      await uploadImage(carousel.id, primary, { sortOrder: 2, isPrimary: false });
    }
  }
  const carouselReady = await waitIndexed(carousel.id);
  if (carouselReady.images.length < 2) {
    throw new Error("轮播样品应有 2 张图");
  }

  const manifest: SeedManifest = {
    fixture: PRIMARY_FILE,
    altFixture: ALT_FILE,
    ownerSid: owner.sid,
    salesSid: sales.sid,
    ownerCredential: owner.credential,
    salesCredential: sales.credential,
    tenantId: owner.tenantId,
    persona,
    fabricSamples,
    carouselSample: { ...carouselReady, role: "carousel" },
    sharedImageCodes: fabricSamples.map((sample) => sample.code),
  };
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(SEED_FILE, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/** 读取 globalSetup 落盘的种子；没有就报清楚的错，而不是让 spec 猜。 */
export async function readSeed(): Promise<SeedManifest> {
  if (!existsSync(SEED_FILE)) {
    throw new Error(`缺少 ${SEED_FILE}：globalSetup 没有跑成功，先修 API / 对象存储`);
  }
  return JSON.parse(await readFile(SEED_FILE, "utf8")) as SeedManifest;
}
