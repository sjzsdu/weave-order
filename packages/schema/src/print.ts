import { z } from "zod";
import { Currency, EntityId, JsonValueSchema, Timestamp, Unit } from "./domain";
import { OrderStatus } from "./entities";

/**
 * 打印中心契约（E5）。
 *
 * 铁律：模板只能引用后端变量白名单；金额、数量、批次永远来自内核视图。
 * 任务幂等键 = 单据 + 模板版本 + 份数 + 操作人（箱唛再加标签序号）。
 */

export const PrintDocumentKind = z.enum([
  "PICKING_LIST",
  "DELIVERY_NOTE",
  "PACKING_LIST",
  "BOX_LABEL",
  "SAMPLE_LABEL",
  "SHELF_LABEL",
  "TEST_LABEL",
]);
export type PrintDocumentKind = z.infer<typeof PrintDocumentKind>;

export const PrintTemplateFormat = z.enum(["HTML", "ZPL", "TSPL"]);
export type PrintTemplateFormat = z.infer<typeof PrintTemplateFormat>;

export const PrintTemplateScope = z.enum(["SYSTEM", "COMPANY", "DOCUMENT_TYPE"]);
export type PrintTemplateScope = z.infer<typeof PrintTemplateScope>;

export const PrintJobStatus = z.enum(["QUEUED", "SENT", "PRINTING", "DONE", "FAILED", "CANCELLED"]);
export type PrintJobStatus = z.infer<typeof PrintJobStatus>;

export const ReprintReason = z.enum([
  "DAMAGED",
  "LOST",
  "CUSTOMER_REQUEST",
  "WRONG_PRINT",
  "OTHER",
]);
export type ReprintReason = z.infer<typeof ReprintReason>;

export const PrinterKind = z.enum(["A4", "THERMAL", "BLUETOOTH"]);
export type PrinterKind = z.infer<typeof PrinterKind>;

export const PrinterConnection = z.enum(["SYSTEM_DRIVER", "RAW_TCP", "USB", "BLUETOOTH"]);
export type PrinterConnection = z.infer<typeof PrinterConnection>;

/**
 * 变量白名单：键是模板里可写的路径，值是视图字段说明。
 * 新增变量必须先在这里注册，模板发布与渲染都按它校验。
 */
export const PRINT_VARIABLES = {
  "tenant.name": "公司名称",
  "tenant.brand": "品牌抬头",
  "tenant.address": "公司地址",
  "tenant.phone": "公司电话",
  "tenant.email": "公司邮箱",
  "customer.name": "客户名称",
  "customer.contactName": "客户联系人",
  "customer.phone": "客户电话",
  "customer.address": "收货地址",
  "order.no": "订单号",
  "order.date": "订单日期",
  "order.dueDate": "交期",
  "order.currency": "币种",
  "shipment.no": "发货单号",
  "shipment.date": "发货日期",
  "shipment.carrier": "承运商",
  "shipment.trackingNumber": "运单号",
  "shipment.address": "发货地址",
  "shipment.boxCount": "箱数",
  "shipment.qty": "发货总数量",
  "box.no": "箱号",
  "box.seq": "标签序号",
  "box.qr": "箱唛二维码内容",
  "box.count": "总箱数",
  "box.grossWeight": "毛重",
  "box.size": "箱规",
  "box.qty": "本箱数量",
  "line.description": "品名",
  "line.sampleCode": "样品编号",
  "line.quantity": "数量",
  "line.unit": "单位",
  "line.unitPrice": "单价（分）",
  "line.lineTotal": "行金额（分）",
  "line.location": "货位",
  "line.lot": "批次",
  "totals.amount": "合计金额（分）",
  "totals.quantity": "合计数量",
  "totals.currency": "币种",
  "meta.printedAt": "打印时间",
  "meta.operator": "操作人",
  "meta.reprintReason": "补打原因",
  "meta.missing": "缺失字段（逗号分隔）",
} as const;
export type PrintVariablePath = keyof typeof PRINT_VARIABLES;

/** 循环块：模板里写 `{{#lines}}…{{/lines}}`，块内只用行字段。 */
export const PRINT_LOOPS = {
  lines: [
    "line.description",
    "line.sampleCode",
    "line.quantity",
    "line.unit",
    "line.unitPrice",
    "line.lineTotal",
    "line.location",
    "line.lot",
  ],
  boxes: ["box.no", "box.seq", "box.qr", "box.qty", "box.grossWeight"],
} as const;
export type PrintLoopName = keyof typeof PRINT_LOOPS;

/** 每种单据允许的变量集合（块内变量按 PRINT_LOOPS 校验）。 */
export const PRINT_DOCUMENT_VARIABLES: Record<PrintDocumentKind, PrintVariablePath[]> = {
  PICKING_LIST: [
    "tenant.name",
    "tenant.brand",
    "customer.name",
    "order.no",
    "order.date",
    "order.dueDate",
    "shipment.no",
    "shipment.date",
    "shipment.boxCount",
    "shipment.qty",
    "totals.quantity",
    "meta.printedAt",
    "meta.operator",
    "meta.missing",
  ],
  DELIVERY_NOTE: [
    "tenant.name",
    "tenant.brand",
    "tenant.address",
    "tenant.phone",
    "tenant.email",
    "customer.name",
    "customer.contactName",
    "customer.phone",
    "customer.address",
    "order.no",
    "order.date",
    "order.currency",
    "shipment.no",
    "shipment.date",
    "shipment.carrier",
    "shipment.trackingNumber",
    "shipment.address",
    "shipment.boxCount",
    "shipment.qty",
    "totals.amount",
    "totals.quantity",
    "totals.currency",
    "meta.printedAt",
    "meta.operator",
    "meta.missing",
  ],
  PACKING_LIST: [
    "tenant.name",
    "customer.name",
    "customer.address",
    "order.no",
    "shipment.no",
    "shipment.boxCount",
    "shipment.qty",
    "totals.quantity",
    "meta.printedAt",
    "meta.operator",
  ],
  BOX_LABEL: [
    "tenant.name",
    "tenant.brand",
    "customer.name",
    "customer.contactName",
    "order.no",
    "shipment.no",
    "shipment.address",
    "shipment.boxCount",
    "box.no",
    "box.seq",
    "box.qr",
    "box.count",
    "box.grossWeight",
    "box.size",
    "box.qty",
    "meta.printedAt",
    "meta.operator",
    "meta.reprintReason",
  ],
  SAMPLE_LABEL: ["tenant.name", "box.qr", "meta.printedAt"],
  SHELF_LABEL: ["tenant.name", "box.qr", "meta.printedAt"],
  TEST_LABEL: ["tenant.name", "box.no", "box.seq", "box.qr", "meta.printedAt", "meta.operator"],
};

export const PrintDocumentKindLabel: Record<PrintDocumentKind, string> = {
  PICKING_LIST: "拣货单",
  DELIVERY_NOTE: "发货单",
  PACKING_LIST: "装箱单",
  BOX_LABEL: "箱唛",
  SAMPLE_LABEL: "样品标签",
  SHELF_LABEL: "货架标签",
  TEST_LABEL: "测试标签",
};

/** 只读视图：字段白名单由后端组装，模板拿不到其它业务数据。 */
export const DocumentParty = z
  .object({
    name: z.string().max(255),
    contactName: z.string().max(255).nullable(),
    phone: z.string().max(64).nullable(),
    email: z.string().max(255).nullable(),
    address: z.string().max(500).nullable(),
  })
  .strict();
export type DocumentParty = z.infer<typeof DocumentParty>;

export const DocumentLine = z
  .object({
    position: z.number().int().nonnegative(),
    description: z.string().max(255),
    sampleCode: z.string().max(64).nullable(),
    quantity: z.number().nonnegative(),
    unit: Unit,
    unitPriceCents: z.number().int().nonnegative().nullable(),
    lineTotalCents: z.number().int().nonnegative().nullable(),
    location: z.string().max(64).nullable(),
    lot: z.string().max(64).nullable(),
  })
  .strict();
export type DocumentLine = z.infer<typeof DocumentLine>;

export const DocumentBox = z
  .object({
    boxNo: z.string().min(1).max(32),
    seq: z.number().int().positive(),
    qr: z.string().min(1).max(255),
    quantity: z.number().nonnegative(),
    itemCount: z.number().int().nonnegative(),
    grossWeightKg: z.string().max(32).nullable(),
    size: z.string().max(64).nullable(),
  })
  .strict();
export type DocumentBox = z.infer<typeof DocumentBox>;

export const DocumentView = z
  .object({
    kind: PrintDocumentKind,
    title: z.string().min(1).max(128),
    locale: z.enum(["zh-CN", "en"]),
    tenant: DocumentParty,
    customer: DocumentParty,
    order: z
      .object({
        id: EntityId,
        no: z.string().min(1).max(64),
        date: Timestamp,
        dueDate: Timestamp.nullable(),
        currency: Currency,
      })
      .strict(),
    shipment: z
      .object({
        id: EntityId,
        no: z.string().min(1).max(64),
        date: Timestamp,
        carrier: z.string().max(128).nullable(),
        trackingNumber: z.string().max(128).nullable(),
        address: z.string().max(500).nullable(),
        boxCount: z.number().int().nonnegative(),
        quantity: z.number().nonnegative(),
      })
      .strict(),
    lines: z.array(DocumentLine),
    boxes: z.array(DocumentBox),
    totals: z
      .object({
        quantity: z.number().nonnegative(),
        currency: Currency,
        amountCents: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    meta: z
      .object({
        printedAt: Timestamp,
        operator: z.string().min(1).max(128),
        reprintReason: ReprintReason.nullable(),
        missing: z.array(z.string().max(64)),
      })
      .strict(),
  })
  .strict();
export type DocumentView = z.infer<typeof DocumentView>;

/** 模板发布：系统模板只读；租户只能发布 COMPANY / DOCUMENT_TYPE。 */
export const PublishPrintTemplateInput = z
  .object({
    kind: PrintDocumentKind,
    scope: PrintTemplateScope.exclude(["SYSTEM"]),
    variant: z.string().min(1).max(64).nullable().optional(),
    name: z.string().min(1).max(128),
    format: PrintTemplateFormat,
    body: z.string().min(1).max(200_000),
    pageSize: z.string().max(32).nullable().optional(),
    changelog: z.string().max(500).nullable().optional(),
  })
  .strict();
export type PublishPrintTemplateInput = z.infer<typeof PublishPrintTemplateInput>;

export const PublishPrintTemplateVersionInput = z
  .object({
    templateId: EntityId,
    body: z.string().min(1).max(200_000),
    pageSize: z.string().max(32).nullable().optional(),
    changelog: z.string().max(500).nullable().optional(),
  })
  .strict();
export type PublishPrintTemplateVersionInput = z.infer<typeof PublishPrintTemplateVersionInput>;

export const PrintTemplateVersion = z
  .object({
    /** 系统模板没有数据库行，ID 使用稳定字符串键；租户模板是 UUID。 */
    id: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive(),
    body: z.string(),
    variables: z.array(z.string()),
    pageSize: z.string().nullable(),
    changelog: z.string().nullable(),
    publishedBy: z.string(),
    publishedAt: Timestamp,
  })
  .strict();
export type PrintTemplateVersion = z.infer<typeof PrintTemplateVersion>;

export const PrintTemplate = z
  .object({
    id: z.string().min(1),
    kind: PrintDocumentKind,
    scope: PrintTemplateScope,
    variant: z.string().nullable(),
    name: z.string(),
    format: PrintTemplateFormat,
    activeVersion: PrintTemplateVersion.nullable(),
    versionCount: z.number().int().nonnegative(),
    /** effective = 当前单据实际会用到它；system 来自内置模板。 */
    isSystem: z.boolean(),
    createdAt: Timestamp,
  })
  .strict();
export type PrintTemplate = z.infer<typeof PrintTemplate>;

export const PrintTemplateList = z.object({ templates: z.array(PrintTemplate) }).strict();
export type PrintTemplateList = z.infer<typeof PrintTemplateList>;

export const CreatePrintJobInput = z
  .object({
    kind: PrintDocumentKind,
    shipmentId: EntityId.optional(),
    boxId: EntityId.optional(),
    orderId: EntityId.optional(),
    copies: z.number().int().min(1).max(50).default(1),
    printerId: EntityId.nullable().optional(),
    templateId: EntityId.nullable().optional(),
    priority: z.number().int().min(0).max(100).default(0),
    reprintReason: ReprintReason.nullable().optional(),
  })
  .strict();
export type CreatePrintJobInput = z.infer<typeof CreatePrintJobInput>;

/** 一单发货一键打印：拣货单 + 箱唛 × 每箱份数 + 发货单。 */
export const PrintShipmentBundleInput = z
  .object({
    shipmentId: EntityId,
    pickingListCopies: z.number().int().min(0).max(10).default(1),
    deliveryNoteCopies: z.number().int().min(0).max(10).default(1),
    boxLabelCopies: z.number().int().min(0).max(20).default(1),
    printerId: EntityId.nullable().optional(),
    labelPrinterId: EntityId.nullable().optional(),
    priority: z.number().int().min(0).max(100).default(0),
  })
  .strict();
export type PrintShipmentBundleInput = z.infer<typeof PrintShipmentBundleInput>;

export const PrintJob = z
  .object({
    id: EntityId,
    kind: PrintDocumentKind,
    documentId: EntityId,
    orderId: EntityId.nullable(),
    shipmentId: EntityId.nullable(),
    boxId: EntityId.nullable(),
    labelSeq: z.number().int().positive().nullable(),
    templateVersion: z.number().int().positive().nullable(),
    format: PrintTemplateFormat,
    copies: z.number().int().positive(),
    priority: z.number().int(),
    status: PrintJobStatus,
    idempotencyKey: z.string(),
    reprintReason: ReprintReason.nullable(),
    requestedBy: z.string(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    printerId: EntityId.nullable(),
    agentId: EntityId.nullable(),
    snapshotId: EntityId.nullable(),
    createdAt: Timestamp,
    completedAt: Timestamp.nullable(),
  })
  .strict();
export type PrintJob = z.infer<typeof PrintJob>;

/** 队列里的载荷只在领任务时返回，列表接口不带正文。 */
export const PrintJobWithPayload = PrintJob.extend({ payload: z.string() }).strict();
export type PrintJobWithPayload = z.infer<typeof PrintJobWithPayload>;

export const PrintJobList = z
  .object({
    jobs: z.array(PrintJob),
    counts: z
      .object({
        queued: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type PrintJobList = z.infer<typeof PrintJobList>;

export const PrintJobBatchResult = z
  .object({
    jobs: z.array(PrintJob),
    /** 幂等命中的任务 ID，前端据此提示「已在队列，不会重复出纸」。 */
    deduplicated: z.array(EntityId),
  })
  .strict();
export type PrintJobBatchResult = z.infer<typeof PrintJobBatchResult>;

export const PrintJobResultInput = z
  .object({
    jobId: EntityId,
    status: z.enum(["PRINTING", "DONE", "FAILED"]),
    message: z.string().max(500).nullable().optional(),
    printerId: EntityId.nullable().optional(),
  })
  .strict();
export type PrintJobResultInput = z.infer<typeof PrintJobResultInput>;

export const PrinterProfile = z
  .object({
    name: z.string().min(1).max(128),
    kind: PrinterKind,
    connection: PrinterConnection,
    address: z.string().max(255).nullable(),
    capabilities: JsonValueSchema.default({}),
    calibration: JsonValueSchema.default({}),
    status: z.enum(["READY", "OFFLINE", "NEEDS_ATTENTION"]).default("OFFLINE"),
  })
  .strict();
export type PrinterProfile = z.infer<typeof PrinterProfile>;

export const Printer = z
  .object({
    id: EntityId,
    agentId: EntityId,
    name: z.string(),
    kind: PrinterKind,
    connection: PrinterConnection,
    address: z.string().nullable(),
    capabilities: JsonValueSchema,
    calibration: JsonValueSchema,
    status: z.enum(["READY", "OFFLINE", "NEEDS_ATTENTION"]),
    lastSeenAt: Timestamp.nullable(),
  })
  .strict();
export type Printer = z.infer<typeof Printer>;

export const PrintAgent = z
  .object({
    id: EntityId,
    name: z.string(),
    location: z.string().nullable(),
    status: z.enum(["ONLINE", "OFFLINE", "DISABLED"]),
    appVersion: z.string().nullable(),
    lastSeenAt: Timestamp.nullable(),
    printers: z.array(Printer),
  })
  .strict();
export type PrintAgent = z.infer<typeof PrintAgent>;

export const RegisterPrintAgentInput = z
  .object({
    name: z.string().min(1).max(128),
    location: z.string().max(128).nullable().optional(),
  })
  .strict();
export type RegisterPrintAgentInput = z.infer<typeof RegisterPrintAgentInput>;

export const RegisteredPrintAgent = z
  .object({
    agent: PrintAgent,
    /** 明文 token 只返回这一次；服务端只存 sha256。 */
    token: z.string().min(20),
  })
  .strict();
export type RegisteredPrintAgent = z.infer<typeof RegisteredPrintAgent>;

export const AgentHeartbeatInput = z
  .object({
    appVersion: z.string().max(64).nullable().optional(),
    printers: z.array(PrinterProfile).max(50).default([]),
  })
  .strict();
export type AgentHeartbeatInput = z.infer<typeof AgentHeartbeatInput>;

export const PrintAgentJob = z
  .object({
    id: EntityId,
    kind: PrintDocumentKind,
    format: PrintTemplateFormat,
    copies: z.number().int().positive(),
    payload: z.string(),
    printerId: EntityId.nullable(),
    printerName: z.string().nullable(),
    printerKind: PrinterKind.nullable(),
    claimedAt: Timestamp,
  })
  .strict();
export type PrintAgentJob = z.infer<typeof PrintAgentJob>;

export const PrintAgentJobList = z.object({ jobs: z.array(PrintAgentJob) }).strict();
export type PrintAgentJobList = z.infer<typeof PrintAgentJobList>;

export const CreateBoxesInput = z
  .object({
    shipmentId: EntityId,
    count: z.number().int().min(1).max(200),
    /** 自动把发货明细均分到各箱；关闭时必须显式给每箱明细。 */
    autoAssign: z.boolean().default(true),
    boxes: z
      .array(
        z
          .object({
            boxNo: z.string().min(1).max(32),
            grossWeightKg: z.string().max(32).nullable().optional(),
            size: z.string().max(64).nullable().optional(),
            items: z.array(
              z
                .object({
                  shipmentItemId: EntityId,
                  quantity: z.number().positive(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();
export type CreateBoxesInput = z.infer<typeof CreateBoxesInput>;

export const BoxItem = z
  .object({
    shipmentItemId: EntityId,
    orderItemId: EntityId,
    description: z.string(),
    quantity: z.number().nonnegative(),
    unit: Unit,
  })
  .strict();
export type BoxItem = z.infer<typeof BoxItem>;

export const OrderBox = z
  .object({
    id: EntityId,
    shipmentId: EntityId,
    boxNo: z.string(),
    seq: z.number().int().positive(),
    qr: z.string(),
    status: z.enum(["OPEN", "PACKED", "VOIDED"]),
    quantity: z.number().nonnegative(),
    items: z.array(BoxItem),
    grossWeightKg: z.string().nullable(),
    size: z.string().nullable(),
    note: z.string().nullable(),
    hasDiscrepancy: z.boolean(),
    verifiedAt: Timestamp.nullable(),
    printedAt: Timestamp.nullable(),
    printCount: z.number().int().nonnegative(),
    createdAt: Timestamp,
  })
  .strict();
export type OrderBox = z.infer<typeof OrderBox>;

export const ShipmentScanEvent = z
  .object({
    id: EntityId,
    type: z.enum(["PICK", "VERIFY"]),
    result: z.enum(["OK", "MISMATCH", "UNKNOWN_CODE", "WRONG_BOX"]),
    qrPayload: z.string().nullable(),
    orderItemId: EntityId.nullable(),
    quantity: z.number().nonnegative().nullable(),
    unit: Unit.nullable(),
    message: z.string().nullable(),
    scannedBy: z.string(),
    createdAt: Timestamp,
  })
  .strict();
export type ShipmentScanEvent = z.infer<typeof ShipmentScanEvent>;

export const ShipmentView = z
  .object({
    id: EntityId,
    orderId: EntityId,
    orderNo: z.string(),
    customerId: EntityId,
    customerName: z.string(),
    status: z.enum(["DRAFT", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"]),
    currency: Currency,
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    address: z.string().nullable(),
    items: z.array(
      z
        .object({
          shipmentItemId: EntityId,
          orderItemId: EntityId,
          sampleId: EntityId,
          sampleCode: z.string(),
          description: z.string(),
          orderedQuantity: z.number().nonnegative(),
          shippedQuantity: z.number().nonnegative(),
          quantity: z.number().nonnegative(),
          unit: Unit,
          unitPriceCents: z.number().int().nonnegative(),
          location: z.string().nullable(),
        })
        .strict(),
    ),
    boxes: z.array(OrderBox),
    scans: z.array(ShipmentScanEvent),
    totalQuantity: z.number().nonnegative(),
    boxQuantity: z.number().nonnegative(),
    /** 箱唛与明细不一致时，打印入口必须变成「先核对差异」。 */
    printBlockedReason: z.enum(["DISCREPANCY", "NO_BOXES", "QUANTITY_MISMATCH"]).nullable(),
    createdAt: Timestamp,
    shippedAt: Timestamp.nullable(),
  })
  .strict();
export type ShipmentView = z.infer<typeof ShipmentView>;

export const OrderShippingSummary = z
  .object({
    orderId: EntityId,
    orderNo: z.string(),
    customerName: z.string(),
    status: OrderStatus,
    currency: Currency,
    totalCents: z.number().int().nonnegative(),
    totalQuantity: z.number().nonnegative(),
    shippedQuantity: z.number().nonnegative(),
    shipmentCount: z.number().int().nonnegative(),
    hasDiscrepancy: z.boolean(),
    updatedAt: Timestamp,
  })
  .strict();
export type OrderShippingSummary = z.infer<typeof OrderShippingSummary>;

export const PickScanInput = z
  .object({
    shipmentId: EntityId,
    /** 订单行样品码或箱唛二维码。 */
    code: z.string().min(1).max(255),
    quantity: z.number().positive().optional(),
  })
  .strict();
export type PickScanInput = z.infer<typeof PickScanInput>;

export const VerifyScanInput = z
  .object({
    shipmentId: EntityId,
    boxQr: z.string().min(1).max(255),
    itemCode: z.string().min(1).max(255),
    quantity: z.number().positive(),
  })
  .strict();
export type VerifyScanInput = z.infer<typeof VerifyScanInput>;

export const ScanResult = z
  .object({
    ok: z.boolean(),
    result: z.enum(["OK", "MISMATCH", "UNKNOWN_CODE", "WRONG_BOX"]),
    message: z.string(),
    box: OrderBox.nullable(),
    expected: z
      .object({
        quantity: z.number().nonnegative(),
        unit: Unit,
        description: z.string(),
      })
      .strict()
      .nullable(),
    actual: z.object({ quantity: z.number().nonnegative(), unit: Unit }).strict().nullable(),
    shipment: ShipmentView,
  })
  .strict();
export type ScanResult = z.infer<typeof ScanResult>;

/** QA 箱唛二维码：tenant/order/box/seq；解析失败一律 UNKNOWN_CODE。 */
export const BoxQrPayload = z
  .object({
    tenantId: EntityId,
    orderId: EntityId,
    boxNo: z.string().min(1).max(32),
    seq: z.number().int().positive(),
  })
  .strict();
export type BoxQrPayload = z.infer<typeof BoxQrPayload>;

export const PrintDevices = z
  .object({
    agents: z.array(PrintAgent),
    printers: z.array(Printer),
  })
  .strict();
export type PrintDevices = z.infer<typeof PrintDevices>;

export const PrintLogEntry = z
  .object({
    id: EntityId,
    jobId: EntityId,
    kind: PrintDocumentKind,
    status: PrintJobStatus,
    copies: z.number().int().positive(),
    documentId: EntityId,
    boxNo: z.string().nullable(),
    requestedBy: z.string(),
    reprintReason: ReprintReason.nullable(),
    message: z.string().nullable(),
    createdAt: Timestamp,
  })
  .strict();
export type PrintLogEntry = z.infer<typeof PrintLogEntry>;

export const PrintLogList = z.object({ logs: z.array(PrintLogEntry) }).strict();
export type PrintLogList = z.infer<typeof PrintLogList>;

/** 打印中心一次只读聚合（抽屉首屏）：队列 + 模板 + 设备 + 最近记录。 */
export const PrintCenterSnapshot = z
  .object({
    queue: PrintJobList,
    templates: z.array(PrintTemplate),
    devices: PrintDevices,
    logs: z.array(PrintLogEntry),
    pendingShipments: z.array(OrderShippingSummary),
  })
  .strict();
export type PrintCenterSnapshot = z.infer<typeof PrintCenterSnapshot>;
