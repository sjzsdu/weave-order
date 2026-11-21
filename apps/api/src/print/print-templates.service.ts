import { printJobs, printTemplateVersions, printTemplates } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CopyPrintTemplateInput,
  PublishPrintTemplateInput,
  PublishPrintTemplateVersionInput,
  PrintTemplateLayout,
  SavePrintTemplateDraftInput,
  hasCapability,
} from "@weave-order/schema";
import type {
  PrintDocumentKind,
  PrintTemplate,
  PrintTemplateDetail,
  PrintTemplateDraft,
  PrintTemplateFormat,
  PrintTemplateVersion,
  PrintTemplateVersionSummary,
} from "@weave-order/schema";
import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm";
import { appendAudit } from "../kernel/audit";
import type { KernelContext } from "../kernel/audit";
import { KernelError } from "../kernel/errors";
import { toIso } from "../kernel/mappers";
import { assertHtmlTemplateSafe } from "./html-safety";
import { OFFICIAL_PRINT_JOB } from "./job-scope";
import { analyzeTemplate, PrintError } from "./template-engine";
import { builtinTemplate, SYSTEM_TEMPLATES } from "./templates";
import { compileLayout, defaultLayoutFor, isLayoutEditable } from "./template-layout";

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

/**
 * 版式读取：库里只存合法版式，但读路径同样做一次结构校验。
 * 历史脏数据（手改库、旧版本写的行）宁可当「文本模板」处理，也不要把非法字段带进编辑器。
 */
function layoutFromRow(row: { layout?: unknown }): PrintTemplateLayout | null {
  const parsed = PrintTemplateLayout.safeParse(row.layout);
  return parsed.success ? parsed.data : null;
}

function versionFromRow(row: typeof printTemplateVersions.$inferSelect): PrintTemplateVersion {
  return {
    id: row.id,
    templateId: row.templateId,
    version: row.version,
    body: row.body,
    variables: Array.isArray(row.variables) ? row.variables.map(String) : [],
    pageSize: row.pageSize,
    layout: layoutFromRow(row),
    changelog: row.changelog,
    publishedBy: row.publishedBy,
    publishedAt: toIso(row.publishedAt),
  };
}

/** 草稿行约定用 version = 0：正经版本从 1 开始，正式打印永远取不到草稿。 */
const DRAFT_VERSION = 0;

/**
 * HTML 模板最终交给 headless Chromium 渲染，天然拥有「影响渲染宿主机」的能力；
 * 因此格式维度上单列一条：HTML 只允许 OWNER 发布，ZPL/TSPL 仍是普通成员可发。
 */
export function assertTemplatePublishAllowed(
  format: PrintTemplateFormat,
  ctx: KernelContext,
): void {
  if (format !== "HTML") return;
  // 能力表 `print.template.publish.html`：HTML 模板会进渲染宿主机，只有 OWNER 能发布。
  if (
    ctx.actor.type === "HUMAN" &&
    ctx.actor.role &&
    hasCapability(ctx.actor.role, "print.template.publish.html")
  ) {
    return;
  }
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
      const published = list.filter((version) => version.version > DRAFT_VERSION);
      const active = published.find((version) => version.id === row.activeVersionId);
      return {
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        variant: row.variant,
        name: row.name,
        format: row.format,
        activeVersion: active ? versionFromRow(active) : null,
        versionCount: published.length,
        hasDraft: list.some((version) => version.version === DRAFT_VERSION),
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
        layout: null,
        changelog: null,
        publishedBy: "system",
        publishedAt: new Date(0).toISOString(),
      },
      versionCount: 1,
      hasDraft: false,
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
        hasDraft: false,
        isSystem: false,
        createdAt: toIso(template.createdAt),
      };
    });
  }

  /** 模板行：不要求已有发布版本（只有草稿的新模板也得能发布）。 */
  private async loadTemplateRow(templateId: string) {
    const rows = await this.db
      .select()
      .from(printTemplates)
      .where(and(eq(printTemplates.id, templateId), eq(printTemplates.tenantId, this.tenantId)))
      .limit(1);
    const template = rows[0];
    if (!template || template.archivedAt) {
      throw new PrintError("PRINT_TEMPLATE_NOT_FOUND", `模板不存在：${templateId}`);
    }
    return template;
  }

  private async publishedVersions(templateId: string) {
    return this.db
      .select()
      .from(printTemplateVersions)
      .where(
        and(
          eq(printTemplateVersions.tenantId, this.tenantId),
          eq(printTemplateVersions.templateId, templateId),
          gt(printTemplateVersions.version, DRAFT_VERSION),
        ),
      )
      .orderBy(desc(printTemplateVersions.version));
  }

  private async loadDraft(templateId: string) {
    const rows = await this.db
      .select()
      .from(printTemplateVersions)
      .where(
        and(
          eq(printTemplateVersions.tenantId, this.tenantId),
          eq(printTemplateVersions.templateId, templateId),
          eq(printTemplateVersions.version, DRAFT_VERSION),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private toTemplate(
    row: typeof printTemplates.$inferSelect,
    versions: Array<typeof printTemplateVersions.$inferSelect>,
  ): PrintTemplate {
    const published = versions.filter((version) => version.version > DRAFT_VERSION);
    const active = published.find((version) => version.id === row.activeVersionId);
    return {
      id: row.id,
      kind: row.kind,
      scope: row.scope,
      variant: row.variant,
      name: row.name,
      format: row.format,
      activeVersion: active ? versionFromRow(active) : null,
      versionCount: published.length,
      hasDraft: versions.some((version) => version.version === DRAFT_VERSION),
      isSystem: false,
      createdAt: toIso(row.createdAt),
    };
  }

  /** 版式优先：传 layout 时编译成正文，再走同一套白名单校验。 */
  private bodyFromInput(
    input: {
      body?: string | undefined;
      layout?: PrintTemplateLayout | null | undefined;
      pageSize?: string | null | undefined;
    },
    kind: PrintDocumentKind,
    format: PrintTemplateFormat,
    fallbackPageSize: string | null,
  ): { body: string; pageSize: string | null; layout: PrintTemplateLayout | null } {
    if (input.layout) {
      const compiled = this.compileLayoutFor(input.layout, kind, format);
      return {
        body: compiled.body,
        pageSize: input.pageSize ?? compiled.pageSize ?? fallbackPageSize,
        layout: input.layout,
      };
    }
    if (!input.body) {
      throw new KernelError("KERNEL_REJECTED", "发布需要 body 或 layout", {
        reason: "INVALID_INPUT",
      });
    }
    return { body: input.body, pageSize: input.pageSize ?? fallbackPageSize, layout: null };
  }

  private compileLayoutFor(
    layout: PrintTemplateLayout,
    kind: PrintDocumentKind,
    format: PrintTemplateFormat,
  ) {
    try {
      return compileLayout(layout, kind, format);
    } catch (error) {
      if (error instanceof PrintError) {
        throw new KernelError("KERNEL_REJECTED", error.message, { reason: error.code });
      }
      throw error;
    }
  }

  /**
   * 复制系统模板为自己的草稿（`POST /print/templates/copy`）。
   * 复制出来的是草稿：正式打印继续用系统模板，直到用户发布第一版。
   */
  async copyFromSystem(input: unknown, ctx: KernelContext): Promise<PrintTemplateDetail> {
    const parsed = CopyPrintTemplateInput.parse(input);
    const source = await this.resolveCopySource(parsed);
    // 草稿正文同样会进 headless Chromium 渲染，所以 HTML 的 OWNER 限制在复制时就要生效。
    // 先鉴权、再判「是否可以可视化编辑」是刻意的：对无权限的角色，PERMISSION_DENIED 是
    // 唯一为真的答案，先说「不支持编辑」等于把「哪些模板能编辑」泄露给了不该知道的人。
    // 因此 SALES 复制 HTML + 暂不支持版式的模板时，看到的是 403 而不是 400。
    assertTemplatePublishAllowed(source.format, ctx);
    if (!isLayoutEditable(source.kind)) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `${source.kind} 还不能可视化编辑，请继续用文本模板发布`,
        { reason: "PRINT_TEMPLATE_LAYOUT_UNSUPPORTED" },
      );
    }
    const taken = await this.db
      .select({ id: printTemplates.id })
      .from(printTemplates)
      .where(
        and(
          eq(printTemplates.tenantId, this.tenantId),
          eq(printTemplates.kind, source.kind),
          eq(printTemplates.name, parsed.name),
        ),
      )
      .limit(1);
    if (taken[0]) throw new KernelError("KERNEL_REJECTED", `模板名称已存在：${parsed.name}`);

    // 系统模板没有库里的版式（内容在代码里），用同版面的默认版式起步；
    // 租户的文本模板没有版式，直接拒绝而不是悄悄换成默认版式——那会丢正文。
    const layout = source.layout ?? (source.fromSystem ? defaultLayoutFor(source.format) : null);
    if (!layout) {
      throw new KernelError(
        "KERNEL_REJECTED",
        `模板「${source.name}」是文本模板，没有可视化版式：请先在编辑器外重新发布，或复制系统样卡`,
        { reason: "PRINT_TEMPLATE_LAYOUT_UNSUPPORTED" },
      );
    }
    const compiled = this.compileLayoutFor(layout, source.kind, source.format);
    const analysis = this.validate(compiled.body, source.kind, source.format);

    const templateId = await this.db.transaction(async (tx) => {
      const templateRows = await tx
        .insert(printTemplates)
        .values({
          tenantId: this.tenantId,
          kind: source.kind,
          scope: parsed.scope,
          variant: parsed.variant ?? null,
          name: parsed.name,
          format: source.format,
          createdBy: ctx.actor.id,
        })
        .returning();
      const template = templateRows[0]!;
      await tx.insert(printTemplateVersions).values({
        tenantId: this.tenantId,
        templateId: template.id,
        version: DRAFT_VERSION,
        body: compiled.body,
        variables: analysis.variables,
        layout,
        pageSize: compiled.pageSize,
        changelog: `复制自 ${source.name}`,
        publishedBy: ctx.actor.id,
      });
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_TEMPLATE_DRAFT_CREATED",
          entityType: "print_template",
          entityId: template.id,
          before: null,
          after: { kind: template.kind, name: template.name, source: source.name },
        },
        this.tenantId,
      );
      return template.id;
    });
    return this.detail(templateId);
  }

  private async resolveCopySource(parsed: ReturnType<typeof CopyPrintTemplateInput.parse>) {
    if (parsed.sourceTemplateId) {
      const system = SYSTEM_TEMPLATES.find((item) => item.key === parsed.sourceTemplateId);
      if (system) {
        return {
          kind: system.kind,
          format: system.format,
          name: system.name,
          layout: null as PrintTemplateLayout | null,
          fromSystem: true,
        };
      }
      const row = await this.loadTemplateRow(parsed.sourceTemplateId);
      const versions = await this.publishedVersions(row.id);
      const active = versions.find((version) => version.id === row.activeVersionId);
      return {
        kind: row.kind,
        format: row.format,
        name: row.name,
        layout: active ? layoutFromRow(active) : null,
        fromSystem: false,
      };
    }
    if (!parsed.kind || !parsed.format) {
      throw new KernelError("KERNEL_REJECTED", "复制模板需要 sourceTemplateId 或 kind + format", {
        reason: "INVALID_INPUT",
      });
    }
    const system = builtinTemplate(parsed.kind, parsed.format);
    if (!system) {
      throw new KernelError("KERNEL_REJECTED", `没有 ${parsed.kind}/${parsed.format} 的系统模板`);
    }
    return {
      kind: parsed.kind,
      format: parsed.format,
      name: system.name,
      layout: null,
      fromSystem: true,
    };
  }

  /** 保存草稿：只写 version = 0 的行，历史版本一行不动。 */
  async saveDraft(
    templateId: string,
    input: unknown,
    ctx: KernelContext,
  ): Promise<PrintTemplateDetail> {
    const parsed = SavePrintTemplateDraftInput.parse(input);
    const template = await this.loadTemplateRow(templateId);
    // 草稿会被渲染成 PDF/HTML，能力边界不能等到发布才拦。
    assertTemplatePublishAllowed(template.format, ctx);
    const existing = await this.loadDraft(template.id);
    const versions = await this.publishedVersions(template.id);
    const active = versions.find((version) => version.id === template.activeVersionId) ?? null;

    let body: string;
    let pageSize: string | null;
    let layout: PrintTemplateLayout | null;
    if (parsed.layout !== undefined && parsed.layout !== null) {
      const compiled = this.compileLayoutFor(parsed.layout, template.kind, template.format);
      body = parsed.body ?? compiled.body;
      pageSize = parsed.pageSize ?? compiled.pageSize;
      layout = parsed.layout;
    } else {
      const fallback = parsed.body ?? existing?.body ?? active?.body ?? null;
      if (!fallback) {
        throw new KernelError("KERNEL_REJECTED", "没有可保存的正文：请先提交 layout 或 body", {
          reason: "INVALID_INPUT",
        });
      }
      body = fallback;
      pageSize = parsed.pageSize ?? existing?.pageSize ?? active?.pageSize ?? null;
      layout = parsed.layout === null ? null : layoutFromRow(existing ?? {});
    }
    const analysis = this.validate(body, template.kind, template.format);

    await this.db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(printTemplateVersions)
          .set({ body, variables: analysis.variables, layout, pageSize })
          .where(eq(printTemplateVersions.id, existing.id));
      } else {
        await tx.insert(printTemplateVersions).values({
          tenantId: this.tenantId,
          templateId: template.id,
          version: DRAFT_VERSION,
          body,
          variables: analysis.variables,
          layout,
          pageSize,
          changelog: null,
          publishedBy: ctx.actor.id,
        });
      }
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_TEMPLATE_DRAFT_SAVED",
          entityType: "print_template",
          entityId: template.id,
          before: existing ? { variables: existing.variables } : null,
          after: { variables: analysis.variables, layout: Boolean(layout) },
        },
        this.tenantId,
      );
    });
    return this.detail(template.id);
  }

  /** 模板详情：已发布版本（含打印次数）+ 草稿，编辑器据此渲染。 */
  async detail(templateId: string): Promise<PrintTemplateDetail> {
    const template = await this.loadTemplateRow(templateId);
    const versions = await this.publishedVersions(template.id);
    const draft = await this.loadDraft(template.id);
    const usage = versions.length
      ? await this.db
          .select({ versionId: printJobs.templateVersionId, used: count() })
          .from(printJobs)
          .where(
            and(
              eq(printJobs.tenantId, this.tenantId),
              eq(printJobs.templateId, template.id),
              OFFICIAL_PRINT_JOB,
              eq(printJobs.status, "DONE"),
            ),
          )
          .groupBy(printJobs.templateVersionId)
      : [];
    const usedByVersion = new Map(usage.map((row) => [row.versionId, Number(row.used)]));
    const summaries: PrintTemplateVersionSummary[] = versions.map((version) => ({
      ...versionFromRow(version),
      printCount: usedByVersion.get(version.id) ?? 0,
    }));

    const draftValue: PrintTemplateDraft | null = draft
      ? {
          body: draft.body,
          layout: layoutFromRow(draft),
          pageSize: draft.pageSize,
          updatedAt: toIso(draft.publishedAt),
        }
      : null;

    return {
      template: this.toTemplate(template, draft ? [...versions, draft] : versions),
      versions: summaries,
      draft: draftValue,
    };
  }

  /** 回滚 = 把当前版本切回历史版本；版本行本身一行不改。 */
  async activateVersion(
    templateId: string,
    versionId: string,
    ctx: KernelContext,
  ): Promise<PrintTemplateDetail> {
    const template = await this.loadTemplateRow(templateId);
    const versions = await this.publishedVersions(template.id);
    const target = versions.find((version) => version.id === versionId);
    if (!target) {
      throw new PrintError("PRINT_TEMPLATE_NOT_FOUND", `这个模板没有该版本：${versionId}`);
    }
    if (template.activeVersionId === target.id) return this.detail(template.id);
    const before = versions.find((version) => version.id === template.activeVersionId) ?? null;
    await this.db.transaction(async (tx) => {
      await tx
        .update(printTemplates)
        .set({ activeVersionId: target.id, updatedAt: new Date() })
        .where(eq(printTemplates.id, template.id));
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRINT_TEMPLATE_ACTIVATED",
          entityType: "print_template",
          entityId: template.id,
          before: { version: before?.version ?? null },
          after: { version: target.version },
        },
        this.tenantId,
      );
    });
    return this.detail(template.id);
  }

  /** 预览 / 试打用：有草稿就渲染草稿，否则用当前发布版本。 */
  async resolveForEdit(templateId: string): Promise<ResolvedTemplate> {
    const template = await this.loadTemplateRow(templateId);
    const draft = await this.loadDraft(template.id);
    if (draft) {
      return {
        templateId: template.id,
        versionId: draft.id,
        version: null,
        name: template.name,
        body: draft.body,
        format: template.format,
        pageSize: draft.pageSize,
        isSystem: false,
      };
    }
    const { version } = await this.loadWithVersion(template.id);
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

  async publishVersion(input: unknown, ctx: KernelContext): Promise<PrintTemplate> {
    const parsed = PublishPrintTemplateVersionInput.parse(input);
    const template = await this.loadTemplateRow(parsed.templateId);
    assertTemplatePublishAllowed(template.format, ctx);
    const draft = await this.loadDraft(template.id);
    const published = await this.publishedVersions(template.id);
    const latest = published[0] ?? null;
    const composed = this.bodyFromInput(
      parsed,
      template.kind,
      template.format,
      latest?.pageSize ?? draft?.pageSize ?? null,
    );
    const analysis = this.validate(composed.body, template.kind, template.format);
    const nextVersion = (latest?.version ?? 0) + 1;

    await this.db.transaction(async (tx) => {
      const versionRows = await tx
        .insert(printTemplateVersions)
        .values({
          tenantId: this.tenantId,
          templateId: template.id,
          version: nextVersion,
          body: composed.body,
          variables: analysis.variables,
          layout: composed.layout,
          pageSize: composed.pageSize,
          changelog: parsed.changelog ?? null,
          publishedBy: ctx.actor.id,
        })
        .returning();
      const version = versionRows[0]!;
      // 发布即消耗草稿：草稿行不再存在，历史版本与正文一一对应。
      if (draft) {
        await tx.delete(printTemplateVersions).where(eq(printTemplateVersions.id, draft.id));
      }
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
          before: { version: latest?.version ?? null },
          after: {
            version: nextVersion,
            variables: analysis.variables,
            layout: Boolean(composed.layout),
          },
        },
        this.tenantId,
      );
    });
    // 模板行在事务里更新过 activeVersionId，必须重新读一次，否则返回的是旧指针。
    const fresh = await this.loadTemplateRow(template.id);
    return this.toTemplate(fresh, await this.publishedVersions(template.id));
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
