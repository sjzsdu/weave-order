import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { openTenantSession } from "@weave-order/db";
import type { PrintAgentJob } from "@weave-order/schema";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { AppDatabaseProvider } from "../platform/database.provider";
import { loadEnv } from "../platform/env";
import { PrintAgentAuthService } from "./agent-auth.service";
import type { AgentIdentity } from "./agent-auth.service";
import { PrintDeviceService } from "./print-devices.service";
import { PrintJobService } from "./print-jobs.service";
import { PrintTemplateService } from "./print-templates.service";
import { PrintViewService } from "./print-view.service";
import { SampleCardService } from "./sample-card.service";

interface Connection {
  socket: WebSocket;
  identity: AgentIdentity;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;

/**
 * 打印代理 WSS 长连接（出站连接，服务端不开入站端口）。
 *
 * 协议刻意做小：`wake`（有新任务）/ `claim` / `result` / `heartbeat` / `ping`。
 * 任务载荷只在 claim 的响应里出现一次，代理不能借此读取任何业务数据。
 */
@Injectable()
export class PrintAgentHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PrintAgentHub.name);
  private server: WebSocketServer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly connections = new Set<Connection>();
  private readonly byAgent = new Map<string, Set<Connection>>();

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(PrintAgentAuthService) private readonly auth: PrintAgentAuthService,
    @Inject(AppDatabaseProvider) private readonly databases: AppDatabaseProvider,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!httpServer) {
      this.logger.warn("没有 HTTP server，打印代理 WSS 未启动");
      return;
    }
    this.server = new WebSocketServer({
      server: httpServer,
      path: "/api/print/agent/ws",
      maxPayload: 256 * 1024,
    });
    this.server.on("connection", (socket, request) => void this.onConnection(socket, request));
    this.timer = setInterval(() => this.heartbeatSockets(), HEARTBEAT_MS);
    this.logger.log("打印代理 WSS → /api/print/agent/ws");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const connection of this.connections) {
      connection.socket.close(1001, "server shutdown");
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async onConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token =
      url.searchParams.get("token") ??
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") || "");
    let identity: AgentIdentity;
    try {
      identity = await this.auth.verify(token);
    } catch {
      socket.close(4401, "unauthorized");
      return;
    }
    const connection: Connection = { socket, identity, alive: true };
    this.connections.add(connection);
    const set = this.byAgent.get(identity.agentId) ?? new Set<Connection>();
    set.add(connection);
    this.byAgent.set(identity.agentId, set);
    await this.setOnline(identity, true);
    socket.send(
      JSON.stringify({
        type: "hello",
        agentId: identity.agentId,
        serverTime: new Date().toISOString(),
      }),
    );

    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data) => void this.onMessage(connection, data));
    socket.on("close", () => void this.onClose(connection));
    socket.on("error", () => {
      /* close 事件会统一清理 */
    });
  }

  private async onMessage(connection: Connection, data: RawData): Promise<void> {
    connection.alive = true;
    let message: Record<string, unknown>;
    try {
      const raw = data as Buffer;
      message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      connection.socket.send(JSON.stringify({ type: "error", message: "消息不是 JSON" }));
      return;
    }
    try {
      const { identity } = connection;
      if (message.type === "ping") {
        connection.socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type === "heartbeat") {
        const { type: _type, ...payload } = message;
        const agent = await this.run(identity.tenantId, async (_jobs, db) => {
          const devices = new PrintDeviceService(db, identity.tenantId);
          return devices.heartbeat(identity.agentId, payload);
        });
        connection.socket.send(JSON.stringify({ type: "heartbeat_ack", agent }));
        return;
      }
      if (message.type === "claim") {
        const limit = Math.min(Math.max(Number(message.limit) || 5, 1), 20);
        const jobs: PrintAgentJob[] = await this.run(identity.tenantId, async (jobs) =>
          jobs.claim(identity.agentId, limit),
        );
        connection.socket.send(JSON.stringify({ type: "jobs", jobs }));
        return;
      }
      if (message.type === "result") {
        const { type: _type, ...payload } = message;
        const job = await this.run(identity.tenantId, async (jobs) =>
          jobs.report(identity.agentId, payload),
        );
        connection.socket.send(JSON.stringify({ type: "result_ack", job }));
        return;
      }
      connection.socket.send(JSON.stringify({ type: "error", message: "未知消息类型" }));
    } catch (error) {
      connection.socket.send(
        JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "处理失败",
        }),
      );
    }
  }

  private async run<T>(
    tenantId: string,
    fn: (
      jobs: PrintJobService,
      db: Awaited<ReturnType<typeof openTenantSession>>["db"],
    ) => Promise<T>,
  ): Promise<T> {
    const env = loadEnv();
    const session = await openTenantSession(this.databases.pool, tenantId);
    try {
      const templates = new PrintTemplateService(session.db, tenantId);
      const jobs = new PrintJobService(
        session.db,
        tenantId,
        new PrintViewService(session.db, tenantId),
        templates,
        new SampleCardService(
          session.db,
          tenantId,
          { shareSecret: env.QUOTE_SHARE_SECRET, publicAppUrl: env.PUBLIC_APP_URL },
          templates,
        ),
      );
      return await fn(jobs, session.db);
    } finally {
      await session.release();
    }
  }

  private async setOnline(identity: AgentIdentity, online: boolean): Promise<void> {
    const session = await openTenantSession(this.databases.pool, identity.tenantId);
    try {
      const devices = new PrintDeviceService(session.db, identity.tenantId);
      if (online) await devices.markOnline(identity.agentId);
      else await devices.markOffline(identity.agentId);
    } catch {
      // 连接关闭清理失败不应阻塞服务退出。
    } finally {
      await session.release();
    }
  }

  private async onClose(connection: Connection): Promise<void> {
    this.connections.delete(connection);
    const set = this.byAgent.get(connection.identity.agentId);
    set?.delete(connection);
    if (!set || set.size === 0) {
      this.byAgent.delete(connection.identity.agentId);
      await this.setOnline(connection.identity, false);
    }
  }

  private heartbeatSockets(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  /** 有新任务时只发「醒一醒」，代理自己 claim；避免广播导致重复出纸。 */
  dispatch(input: { tenantId: string; agentId: string | null }): void {
    const targets = input.agentId
      ? (this.byAgent.get(input.agentId) ?? new Set<Connection>())
      : [...this.connections].filter(
          (connection) => connection.identity.tenantId === input.tenantId,
        );
    const message = JSON.stringify({ type: "wake", at: new Date().toISOString() });
    for (const connection of targets) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(message);
      }
    }
  }

  /** 队列页展示：在线代理数（不暴露连接细节）。 */
  onlineAgents(tenantId: string): string[] {
    return [...this.connections]
      .filter((connection) => connection.identity.tenantId === tenantId)
      .map((connection) => connection.identity.agentId);
  }
}
