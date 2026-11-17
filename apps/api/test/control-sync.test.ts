import { describe, expect, it, vi } from "vitest";
import {
  createHttpDeliver,
  runControlSyncOnce,
  type OutboxJob,
  type OutboxStore,
} from "../src/platform/control-sync";

function resolved(): Promise<void>;
function resolved<T>(value: T): Promise<T>;
function resolved<T>(value?: T): Promise<T | void> {
  return Promise.resolve(value);
}

/** 内存 store，记录状态流转，供纯逻辑单测。 */
function memoryStore(jobs: OutboxJob[]): OutboxStore & {
  snapshot: () => Record<
    string,
    OutboxJob & { status: string; nextAttemptAt: Date; lastError?: string }
  >;
} {
  const state = new Map<
    string,
    OutboxJob & { status: string; nextAttemptAt: Date; lastError?: string }
  >();
  for (const job of jobs) {
    state.set(job.id, { ...job, status: "pending", nextAttemptAt: new Date(0) });
  }
  return {
    claimDue(now, limit) {
      return resolved(
        [...state.values()]
          .filter(
            (j) => (j.status === "pending" || j.status === "failed") && j.nextAttemptAt <= now,
          )
          .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
          .slice(0, limit)
          .map(({ id, slug, name, ownerEmail, attempts }) => ({
            id,
            slug,
            name,
            ownerEmail,
            attempts,
          })),
      );
    },
    markSynced(id) {
      const row = state.get(id)!;
      row.status = "synced";
      row.lastError = undefined;
      return resolved();
    },
    markFailed(id, patch) {
      const row = state.get(id)!;
      row.attempts = patch.attempts;
      row.status = patch.status;
      row.nextAttemptAt = patch.nextAttemptAt;
      row.lastError = patch.lastError;
      return resolved();
    },
    insert() {
      return resolved();
    },
    snapshot: () => Object.fromEntries(state),
  };
}

function job(id: string, attempts = 0): OutboxJob {
  return { id, slug: `t-${id}`, name: `公司 ${id}`, ownerEmail: "boss@example.com", attempts };
}

const ok = () => resolved();
const boom =
  (message = "网络错误") =>
  () =>
    Promise.reject(new Error(message));

describe("控制面 outbox 可靠投递", () => {
  it("成功投递后标记 synced", async () => {
    const store = memoryStore([job("a")]);
    const result = await runControlSyncOnce(store, ok);
    expect(result).toEqual({ attempted: 1, synced: 1, failed: 0, dead: 0 });
    expect(store.snapshot()["a"]!.status).toBe("synced");
  });

  it("失败后 attempts+1、指数退避、保持 failed", async () => {
    const store = memoryStore([job("a")]);
    const base = new Date("2026-01-01T00:00:00Z");
    const result = await runControlSyncOnce(store, boom(), {
      now: () => base,
      backoffBaseMs: 1000,
    });
    expect(result.failed).toBe(1);
    const row = store.snapshot()["a"]!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("网络错误");
    expect(row.nextAttemptAt.getTime() - base.getTime()).toBe(1000);
  });

  it("达到最大尝试次数转 dead 并触发告警回调", async () => {
    const store = memoryStore([job("a", 2)]);
    const onDead = vi.fn();
    const result = await runControlSyncOnce(store, boom("仍失败"), { maxAttempts: 3, onDead });
    expect(result.dead).toBe(1);
    expect(store.snapshot()["a"]!.status).toBe("dead");
    expect(onDead).toHaveBeenCalledOnce();
  });

  it("单条失败不影响同轮其他行", async () => {
    const store = memoryStore([job("a"), job("b")]);
    const deliver = (j: OutboxJob) => (j.id === "a" ? boom("坏行")() : ok());
    const result = await runControlSyncOnce(store, deliver);
    expect(result.attempted).toBe(2);
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(store.snapshot()["b"]!.status).toBe("synced");
  });

  it("dead 行不再被 claim（不计入下一轮）", async () => {
    const store = memoryStore([job("a", 3)]);
    await runControlSyncOnce(store, boom("x"), { maxAttempts: 3 });
    const result = await runControlSyncOnce(store, ok);
    expect(result.attempted).toBe(0);
  });

  it("HTTP 投递：非 2xx 抛错、携带共享密钥与 slug", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => resolved(new Response("no", { status: 401 })));
    const deliver = createHttpDeliver({
      baseUrl: "https://platform.example.test/",
      secret: "s3cret",
      fetchImpl,
    });
    await expect(deliver(job("a"))).rejects.toThrow("401");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://platform.example.test/platform/api/internal/tenants");
    expect(init?.headers).toMatchObject({ "x-weave-internal": "s3cret" });
    expect(JSON.parse(init?.body as string)).toMatchObject({ slug: "t-a" });
  });

  it("HTTP 投递：2xx 视为成功", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      resolved(new Response(JSON.stringify({ created: true }), { status: 201 })),
    );
    const deliver = createHttpDeliver({
      baseUrl: "https://platform.example.test",
      secret: "s",
      fetchImpl,
    });
    await expect(deliver(job("a"))).resolves.toBeUndefined();
  });
});
