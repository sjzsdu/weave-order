import { DEFAULT_TENANT_ID } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { AuditAction } from "@weave-order/schema";
import {
  createEmbeddingProviderFromEnv,
  createImageEmbeddingProviderFromEnv,
} from "../platform/embedding";
import type { EmbeddingProvider, ImageEmbeddingProvider } from "../platform/embedding";
import { createCaptionerFromEnv } from "../platform/caption";
import { loadEnv } from "../platform/env";
import { createPrintCenter } from "../print";
import { createOcrGatewayFromEnv } from "../platform/ocr";
import type { OcrGateway } from "../platform/ocr";
import { createObjectStorageFromEnv } from "../platform/storage";
import type { ObjectStorage } from "../platform/storage";
import { objectUrl } from "../platform/thumbnail";
import { AccessService } from "./access.service";
import { countAuditLog, listAuditLog, listBusinessAuditLog } from "./audit";
import { AuditLogService } from "./audit-log.service";
import type { AuditCountFilter } from "./audit";
import { KernelError } from "./errors";
import { LlmSettingsService } from "./llm-settings.service";
import { QuotePricingService } from "./quote-pricing.service";
import { UsageService } from "./usage.service";
import { ContactService } from "./contacts.service";
import { CustomerService } from "./customers.service";
import { CodeNumberService } from "./code-number.service";
import { CompositionService } from "./composition.service";
import { FieldOptionsService } from "./field-options.service";
import { ImportService } from "./import.service";
import { InboundRepliesService } from "./inbound-replies.service";
import { InboundService } from "./inbound.service";
import { IntentService } from "./intents.service";
import { ItemService } from "./items.service";
import { MeasureUnitsService } from "./measure-units.service";
import { OrderService } from "./orders.service";
import { OrderShipmentService } from "./order-shipments.service";
import { OnboardingStateService } from "./onboarding-state.service";
import { PricingService } from "./pricing.service";
import { QuoteService } from "./quotes.service";
import { ReceivableService } from "./receivables.service";
import { RevisionService } from "./revisions.service";
import { ResourceFieldService } from "./resource-fields.service";
import { ImageIndexService } from "./image-index.service";
import { MediaMaintenanceService } from "./media-maintenance.service";
import { SampleImageService } from "./sample-images.service";
import { SampleIndexService } from "./sample-index.service";
import { SampleThumbService } from "./sample-thumbs.service";
import { SampleService } from "./samples.service";
import { SearchService } from "./search.service";
import { ShareService } from "./shares.service";
import { ShipmentService } from "./shipments.service";
import { TenancyService } from "./tenancy.service";
import { WorkbenchService } from "./workbench.service";

export interface KernelOptions {
  /**
   * 内核绑定的租户。网关为每个已认证请求创建一个绑定了 tenantId 的内核；
   * 未传时退回默认演示租户（仅本地演示 / 单租户脚本）。
   */
  tenantId?: string;
  /** 客户报价链接签名密钥；缺省读 `QUOTE_SHARE_SECRET`。 */
  shareSecret?: string;
  /** 客户报价页站点根地址；缺省读 `PUBLIC_APP_URL`。 */
  publicAppUrl?: string;
  /** 对象存储；缺省按环境变量创建。测试可注入假实现，避免真实网络。 */
  storage?: ObjectStorage;
  /** 合并预览 / 撤销票据的签名密钥；缺省回落到 QUOTE_SHARE_SECRET 或本地固定值。 */
  mergeSecret?: string;
  /** 图像 embedding provider；缺省按环境变量创建（默认 local-stub，无 key 可跑）。 */
  imageEmbedder?: ImageEmbeddingProvider;
  /** OCR 网关；缺省按环境变量创建（未配 key 时显式不可用，不返回假字段）。 */
  ocrGateway?: OcrGateway;
  /** 送模型前的缩图长边（0 = 关闭）。单测用假图片时需要关掉。 */
  imageEmbeddingMaxEdge?: number;
}

/**
 * 确定性内核的唯一装配入口。
 *
 * 这里的每个 service 都是业务表的唯一写入者；工具层只能拿到这个对象，
 * 拿不到 Db / 连接池，因此不存在「绕过内核改账本」的编码路径。
 *
 * 多租户：`db` 必须是已设置 `app.tenant_id` 的会话连接（生产），
 * 或 owner 连接（迁移 / 平台控制面）。绑定租户用于写 tenant_id 与审计。
 */
export function createKernel(db: Db, embedder?: EmbeddingProvider, options: KernelOptions = {}) {
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const env = loadEnv();
  // 默认 provider 由环境变量决定；显式注入（测试/演示）优先。
  const activeEmbedder =
    embedder ?? createEmbeddingProviderFromEnv(env, process.env.DASHSCOPE_API_KEY);
  // 图像向量与文本向量是两套模型：不同空间、不同表、不同阈值。
  const activeImageEmbedder =
    options.imageEmbedder ??
    createImageEmbeddingProviderFromEnv(env, process.env.DASHSCOPE_API_KEY);
  const fieldOptions = new FieldOptionsService(db, tenantId);
  // 成分解析要查原料字典，所以排在 fieldOptions 之后。
  const composition = new CompositionService(fieldOptions);
  const resourceFields = new ResourceFieldService(db, tenantId, composition);
  const codeNumber = new CodeNumberService(db, tenantId);
  const mergeSecret =
    options.mergeSecret ??
    process.env.MERGE_UNDO_SECRET ??
    env.QUOTE_SHARE_SECRET ??
    "weave-order-local-merge-secret";
  const customers = new CustomerService(db, tenantId, fieldOptions, resourceFields, mergeSecret, codeNumber);
  const contacts = new ContactService(db, tenantId, customers);
  const storage = options.storage ?? createObjectStorageFromEnv(env);
  const sampleImages = new SampleImageService(db, tenantId, storage, env);
  const thumbs = new SampleThumbService(db, tenantId, storage);
  const mediaMaintenance = new MediaMaintenanceService(db, tenantId, storage, thumbs);
  const sampleIndex = new SampleIndexService(db, activeEmbedder, tenantId);
  const imageMaxEdge = options.imageEmbeddingMaxEdge ?? env.IMAGE_EMBEDDING_MAX_EDGE;
  const imageIndex = new ImageIndexService(db, activeImageEmbedder, tenantId, storage, {
    maxEdge: imageMaxEdge,
  });
  const samples = new SampleService(
    db,
    activeEmbedder,
    tenantId,
    sampleImages,
    sampleIndex,
    imageIndex,
    thumbs,
    resourceFields,
    codeNumber,
    composition,
  );
  const pricing = new PricingService(db, tenantId);
  const shipments = new ShipmentService(db, customers, tenantId, codeNumber);
  const quotePricing = new QuotePricingService(customers, samples, pricing);
  const quotes = new QuoteService(db, customers, samples, pricing, quotePricing, tenantId, codeNumber);
  const orders = new OrderService(db, customers, pricing, tenantId, codeNumber);
  const orderShipments = new OrderShipmentService(db, tenantId);
  const receivables = new ReceivableService(db, tenantId);
  const workbench = new WorkbenchService(
    db,
    orders,
    customers,
    orderShipments,
    shipments,
    receivables,
    tenantId,
  );
  const revisions = new RevisionService(db, tenantId);
  const captioner = createCaptionerFromEnv(
    env,
    env.CAPTION_FALLBACK,
    env.IMAGE_EMBEDDING_API_KEY ?? process.env.DASHSCOPE_API_KEY,
  );
  const search = new SearchService(
    db,
    activeEmbedder,
    tenantId,
    sampleImages,
    env.SEARCH_SEMANTIC_MIN_SCORE,
    {
      index: imageIndex,
      embedder: activeImageEmbedder,
      captioner,
      minSimilarity: env.SEARCH_IMAGE_MIN_SIMILARITY,
      textMinSimilarity: env.SEARCH_IMAGE_TEXT_MIN_SIMILARITY,
      maxEdge: imageMaxEdge,
    },
  );
  const importing = new ImportService(db, customers, samples, sampleIndex, tenantId);
  const tenancy = new TenancyService(db);
  const access = new AccessService(db);
  const llmSettings = new LlmSettingsService(db, tenantId);
  const usage = new UsageService(db, tenantId);
  const intents = new IntentService(db, tenantId);
  const items = new ItemService(db, tenantId);
  const inbound = new InboundService(db, tenantId, {
    ocr: options.ocrGateway ?? createOcrGatewayFromEnv(env),
    storage,
    intents,
    customers,
    samples,
    items,
  });
  const onboardingState = new OnboardingStateService(db, tenantId);
  const inboundReplies = new InboundRepliesService(db, tenantId, {
    retentionDays: env.INBOUND_RAW_RETENTION_DAYS,
    resolveImageUrl: async (objectKey) => {
      const url = await objectUrl(env, storage, objectKey);
      if (!url) {
        throw new KernelError("KERNEL_REJECTED", "对象存储未配置，无法读取截图", {
          reason: "MEDIA_STORAGE_UNAVAILABLE",
        });
      }
      return url;
    },
  });
  const shares = new ShareService(db, tenantId, {
    secret: options.shareSecret ?? env.QUOTE_SHARE_SECRET,
    publicAppUrl: options.publicAppUrl ?? env.PUBLIC_APP_URL,
  });
  const print = createPrintCenter(db, tenantId, {
    shareSecret: options.shareSecret ?? env.QUOTE_SHARE_SECRET,
    publicAppUrl: options.publicAppUrl ?? env.PUBLIC_APP_URL,
  });
  const auditLogRead = new AuditLogService(db, tenantId, storage);
  const measureUnits = new MeasureUnitsService(db, tenantId);

  return {
    tenantId,
    access,
    fieldOptions,
    resourceFields,
    codeNumber,
    customers,
    contacts,
    samples,
    sampleIndex,
    sampleImages,
    thumbs,
    mediaMaintenance,
    imageIndex,
    pricing,
    shipments,
    quotes,
    orders,
    orderShipments,
    receivables,
    workbench,
    revisions,
    search,
    importing,
    tenancy,
    quotePricing,
    llmSettings,
    usage,
    intent: intents,
    items,
    inbound,
    onboardingState,
    inboundReplies,
    shares,
    print,
    measureUnits,
    auditLog: auditLogRead,
    audit: {
      list: (limit?: number, entityId?: string) => listAuditLog(db, limit, tenantId, entityId),
      businessEvents: (limit: number, actions: AuditAction[]) =>
        listBusinessAuditLog(db, limit, tenantId, actions),
      count: (filter: AuditCountFilter) => countAuditLog(db, tenantId, filter),
    },
  };
}

export type Kernel = ReturnType<typeof createKernel>;

export { KernelError, isKernelError, errorChainMessage } from "./errors";
export { QuoteLinkError } from "./shares.service";
export { parseShareToken } from "./share-token";
export type { KernelContext } from "./audit";
export { mayViewCost } from "./mappers";
export { ownerScopeFilter, scopeWindowOf } from "./data-scope";
export type { EmbeddingProvider } from "../platform/embedding";
export { formatMoney } from "./money";
