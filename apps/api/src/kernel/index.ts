import { DEFAULT_TENANT_ID } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  createEmbeddingProviderFromEnv,
  createImageEmbeddingProviderFromEnv,
} from "../platform/embedding";
import type { EmbeddingProvider, ImageEmbeddingProvider } from "../platform/embedding";
import { createCaptionerFromEnv } from "../platform/caption";
import { loadEnv } from "../platform/env";
import { createPrintCenter } from "../print";
import { createObjectStorageFromEnv } from "../platform/storage";
import type { ObjectStorage } from "../platform/storage";
import { AccessService } from "./access.service";
import { listAuditLog } from "./audit";
import { LlmSettingsService } from "./llm-settings.service";
import { QuotePricingService } from "./quote-pricing.service";
import { UsageService } from "./usage.service";
import { CustomerService } from "./customers.service";
import { ImportService } from "./import.service";
import { InboundRepliesService } from "./inbound-replies.service";
import { OrderService } from "./orders.service";
import { OrderShipmentService } from "./order-shipments.service";
import { PricingService } from "./pricing.service";
import { QuoteService } from "./quotes.service";
import { ReceivableService } from "./receivables.service";
import { RevisionService } from "./revisions.service";
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
  /** 图像 embedding provider；缺省按环境变量创建（默认 local-stub，无 key 可跑）。 */
  imageEmbedder?: ImageEmbeddingProvider;
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
  const customers = new CustomerService(db, tenantId);
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
  );
  const pricing = new PricingService(db, tenantId);
  const shipments = new ShipmentService(db, customers, tenantId);
  const quotes = new QuoteService(db, customers, samples, pricing, tenantId);
  const orders = new OrderService(db, customers, pricing, tenantId);
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
  const quotePricing = new QuotePricingService(customers, samples, pricing);
  const llmSettings = new LlmSettingsService(db, tenantId);
  const usage = new UsageService(db, tenantId);
  const inboundReplies = new InboundRepliesService(db, tenantId);
  const shares = new ShareService(db, tenantId, {
    secret: options.shareSecret ?? env.QUOTE_SHARE_SECRET,
    publicAppUrl: options.publicAppUrl ?? env.PUBLIC_APP_URL,
  });
  const print = createPrintCenter(db, tenantId);

  return {
    tenantId,
    access,
    customers,
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
    inboundReplies,
    shares,
    print,
    audit: {
      list: (limit?: number, entityId?: string) => listAuditLog(db, limit, tenantId, entityId),
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
