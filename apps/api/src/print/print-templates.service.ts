import { printTemplateVersions, printTemplates } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { PublishPrintTemplateInput, PublishPrintTemplateVersionInput } from "@weave-order/schema";
import type {
  PrintDocumentKind,
  PrintTemplate,
  PrintTemplateFormat,
  PrintTemplateVersion,
} from "@weave-order/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { appendAudit } from "../kernel/audit";
import type { KernelContext } from "../kernel/audit";
import { KernelError } from "../kernel/errors";
import { toIso } from "../kernel/mappers";
import { assertHtmlTemplateSafe } from "./html-safety";
import { analyzeTemplate, PrintError } from "./template-engine";
import { builtinTemplate, SYSTEM_TEMPLATES } from "./templates";

export interface ResolvedTemplate {
  templateId: string | null;
  versionId: string | null;
  version: number | null;
  name: string;
  body: string;
  format: PrintTemplateFormat;
  pageSize: string | null;
  isSystem: boolean;
}

function versionFromRow(row: typeof printTemplateVersions.$inferSelect): PrintTemplateVersion {
  return {
    id: row.id,
    templateId: row.templateId,
    version: row.version,
    body: row.body,
    variables: Array.isArray(row.variables) ? row.variables.map(String) : [],
    pageSize: row.pageSize,
    changelog: row.changelog,
    publishedBy: row.publishedBy,
    publishedAt: toIso(row.publishedAt),
  };
}

/**
 * HTML 模板最终交给 headless Chromium 渲染，天然拥有「影响渲染宿主机」的能力；
 * 因此格式维度上单列一条：HTML 只允许 OWNER 发布，ZPL/TSPL 仍是普通成员可发。
 */
export function assertTemplatePublishAllowed(
  format: PrintTemplateFormat,
  ctx: KernelContext,
): void {
  if (format !== "HTML") return;
  if (ctx.actor.type === "HUMAN" && ctx.actor.role === "OWNER") return;
  throw new KernelError("PERMISSION_DENIED", "HTML 打印模板只能由 OWNER 发布", {
    reason: "PRINT_TEMPLATE_FORBIDDEN",
  });
}

export class PrintTemplateService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  /**
   * 模板优先级：单据类型覆盖 → 公司覆盖 → 系统模板。
   * 同层多套时按 `variant` 精确匹配，其次默认（variant = null）。
   */
  async resolve(input: {
    kind: PrintDocumentKind;
    format: PrintTemplateFormat;
    templateId?: string | null;
    variant?: string | null;
  }): Promise<ResolvedTemplate> {
    if (input.templateId) {
      const { template, version } = await this.loadWithVersion(input.templateId);
      if (template.kind !== input.kind || template.format !== input.format) {
        throw new PrintError(
          "PRINT_TEMPLATE_NOT_FOUND",
          `模板 ${template.name} 不适用于 ${input.kind}/${input.format}`,
        );
      }
      return {
        templateId: template.id,
        versionId: version.id,
        version: version.version,
        name: template.name,
        body: version.body,
        format: template.format,
        pageSize: version.pageSize,
        isSystem: false,
      };
    }

    const rows = await this.db
      .select()
      .from(printTemplates)
      .where(
        and(
          eq(printTemplates.tenantId, this.tenantId),
          eq(printTemplates.kind, input.kind),
          eq(printTemplates.format, input.format),
          isNull(printTemplates.archivedAt),
        ),
      )
      .orderBy(
        desc(printTemplates.scope),
        asc(printTemplates.variant),
        desc(printTemplates.updatedAt),
      );
    const candidates = rows.filter(
      (row) => row.activeVersionId && (row.scope === "DOCUMENT_TYPE" || row.scope === "COMPANY"),
    );
    if (candidates.length > 0) {
      const selected =
        candidates.find((row) => input.variant && row.variant === input.variant) ??
        candidates.find((row) => row.variant === null) ??
        candidates[0]!;
      const { template, version } = await this.loadWithVersion(selected.id);
      return {
        templateId: template.id,
        versionId: version.id,
        version: version.version,
        name: template.name,
        body: version.body,
        format: template.format,
        pageSize: version.pageSize,
        isSystem: false,
      };
    }

    const system = builtinTemplate(input.kind, input.format);
    if (!system) {
      throw new PrintError(
        "PRINT_TEMPLATE_NOT_FOUND",
        `没有 ${input.kind} 的 ${input.format} 模板，请先发布公司模板`,
      );
    }
    return {
      templateId: null,
      versionId: null,
      version: null,
      name: system.name,
      body: system.body,
      format: system.format,
      pageSize: system.pageSize,
      isSystem: true,
    };
  }

  private async loadWithVersion(templateId: string) {
    const rows = await this.db
      .select()
      .from(printTemplates)
      .where(and(eq(printTemplates.id, templateId), eq(printTemplates.tenantId, this.tenantId)))
      .limit(1);
    const template = rows[0];
    if (!template || template.archivedAt) {
      throw new PrintError("PRINT_TEMPLATE_NOT_FOUND", `模板不存在：${templateId}`);
    }
    if (!template.activeVersionId) {
      throw new PrintError("PRINT_TEMPLATE_NOT_FOUND", `模板没有已发布版本：${template.name}`);
    }
    const versionRows = await this.db
      .select()
      .from(printTemplateVersions)
      .where(eq(printTemplateVersions.id, template.activeVersionId))
      .limit(1);
    const version = versionRows[0];
    if (!version) {
      throw new PrintError("PRINT_TEMPLATE_NOT_FOUND", `模板版本不存在：${template.name}`);
    }
    return { template, version };
  }

  async list(kind?: PrintDocumentKind): Promise<PrintTemplate[]> {
    const rows = await this.db
      .select()
      .from(printTemplates)
      .where(
        and(
          eq(printTemplates.tenantId, this.tenantId),
          isNull(printTemplates.archivedAt),
          ...(kind ? [eq(printTemplates.kind, kind)] : []),
        ),
      )
      .orderBy(asc(printTemplates.kind), desc(printTemplates.updatedAt));
    const versions = rows.length
      ? await this.db
          .select()
          .from(printTemplateVersions)
          .where(eq(printTemplateVersions.tenantId, this.tenantId))
      : [];
    const versionsByTemplate = new Map<string, typeof versions>();
    for (const version of versions) {
      const list = versionsByTemplate.get(version.templateId) ?? [];
      list.push(version);
      versionsByTemplate.set(version.templateId, list);
    }
    const userTemplates: PrintTemplate[] = rows.map((row) => {
      const list = versionsByTemplate.get(row.id) ?? [];
      const active = list.find((version) => version.id === row.activeVersionId);
      return {
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        variant: row.variant,
        name: row.name,
        format: row.format,
        activeVersion: active ? versionFromRow(active) : null,
        versionCount: list.length,
        isSystem: false,
        createdAt: toIso(row.createdAt),
      };
    });
    const systemTemplates: PrintTemplate[] = SYSTEM_TEMPLATES.filter((template) =>
      kind ? template.kind === kind : true,
    ).map((template) => ({
      id: template.key,
      kind: template.kind,
      scope: "SYSTEM",
      variant: template.variant,
      name: template.name,
      format: template.format,
      activeVersion: {
        id: `${template.key}/v1`,
        templateId: template.key,
        version: 1,
        body: template.body,
        variables: [],
        pageSize: template.pageSize,
        changelog: null,
        publishedBy: "system",
        publishedAt: new Date(0).toISOString(),
      },
      versionCount: 1,
      isSystem: true,
      createdAt: new Date(0).toISOString(),
    }));
    return [...userTemplates, ...systemTemplates];
  }

  async publish(input: unknown, ctx: KernelContext): Promise<PrintTemplate> {
    const parsed = PublishPrintTemplateInput.parse(input);
    assertTemplatePublishAllowed(parsed.format, ctx);
    const analysis = this.validate(parsed.body, parsed.kind, parsed.format);
    const existing = await this.db
      .select()
      .from(printTemplates)
      .where(
        and(
          eq(printTemplates.tenantId, this.tenantId),
          eq(printTemplates.kind, parsed.kind),
          eq(printTemplates.name, parsed.name),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new KernelError("KERNEL_REJECTED", `模板名称已存在：${parsed.name}`);
    }

    return this.db.transaction(async (tx) => {
      const templateRows = await tx
        .insert(printTemplates)
        .values({
          tenantId: this.tenantId,
          kind: parsed.kind,
          scope: parsed.scope,
          variant: parsed.variant ?? null,
          name: parsed.name,
          format: parsed.format,
          createdBy: ctx.actor.id,
        })
        .returning();
      const template = templateRows[0]!;
      const versionRows = await tx
        .insert(printTemplateVersions)
        .values({
          tenantId: this.tenantId,
          templateId: template.id,
          version: 1,
          body: parsed.body,
          variables: analysis.variables,
          pageSize: parsed.pageSize ?? null,
          changelog: parsed.changelog ?? null,
          publishedBy: ctx.actor.id,
        })
        .returning();
      const version = versionRows[0]!;
      await tx
        .update(printTemplates)
        .set({ activeVersionId: version.id, updatedAt: new Date() })
        .where(eq(printTemplates.id, template.id));
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_TEMPLATE_PUBLISHED",
          entityType: "print_template",
          entityId: template.id,
          before: null,
          after: {
            kind: template.kind,
            name: template.name,
            version: 1,
            variables: analysis.variables,
          },
        },
        this.tenantId,
      );
      return {
        id: template.id,
        kind: template.kind,
        scope: template.scope,
        variant: template.variant,
        name: template.name,
        format: template.format,
        activeVersion: versionFromRow(version),
        versionCount: 1,
        isSystem: false,
        createdAt: toIso(template.createdAt),
      };
    });
  }

  async publishVersion(input: unknown, ctx: KernelContext): Promise<PrintTemplate> {
    const parsed = PublishPrintTemplateVersionInput.parse(input);
    const { template } = await this.loadWithVersion(parsed.templateId);
    assertTemplatePublishAllowed(template.format, ctx);
    const analysis = this.validate(parsed.body, template.kind, template.format);
    const latest = await this.db
      .select()
      .from(printTemplateVersions)
      .where(eq(printTemplateVersions.templateId, template.id))
      .orderBy(desc(printTemplateVersions.version))
      .limit(1);
    const nextVersion = (latest[0]?.version ?? 0) + 1;

    return this.db.transaction(async (tx) => {
      const versionRows = await tx
        .insert(printTemplateVersions)
        .values({
          tenantId: this.tenantId,
          templateId: template.id,
          version: nextVersion,
          body: parsed.body,
          variables: analysis.variables,
          pageSize: parsed.pageSize ?? latest[0]?.pageSize ?? null,
          changelog: parsed.changelog ?? null,
          publishedBy: ctx.actor.id,
        })
        .returning();
      const version = versionRows[0]!;
      await tx
        .update(printTemplates)
        .set({ activeVersionId: version.id, updatedAt: new Date() })
        .where(eq(printTemplates.id, template.id));
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_TEMPLATE_PUBLISHED",
          entityType: "print_template",
          entityId: template.id,
          before: { version: latest[0]?.version ?? null },
          after: { version: nextVersion, variables: analysis.variables },
        },
        this.tenantId,
      );
      return {
        id: template.id,
        kind: template.kind,
        scope: template.scope,
        variant: template.variant,
        name: template.name,
        format: template.format,
        activeVersion: versionFromRow(version),
        versionCount: nextVersion,
        isSystem: false,
        createdAt: toIso(template.createdAt),
      };
    });
  }

  private validate(body: string, kind: PrintDocumentKind, format: PrintTemplateFormat) {
    try {
      if (format === "HTML") assertHtmlTemplateSafe(body);
      return analyzeTemplate(body, kind);
    } catch (error) {
      if (error instanceof PrintError) {
        throw new KernelError("KERNEL_REJECTED", error.message, { reason: error.code });
      }
      throw error;
    }
  }
}
