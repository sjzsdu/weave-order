import { create } from "zustand";
import type {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalItem,
  CreateCustomerInput,
  CreateSampleInput,
  Customer,
  FabricSample,
  PanoramaSnapshot,
  T002SearchFabricBySpecInput,
  T002SearchFabricBySpecResult,
  T004GenerateQuoteDraftInput,
  T004GenerateQuoteDraftResult,
  T005CreateSampleShipmentInput,
  T005CreateSampleShipmentResult,
} from "@weave-order/schema";
import { apiClient } from "./api";
import { messageOf, shortId } from "./lib";

export type WindowKey = "intent" | "review" | "panorama";

/** 本会话的人类决策流水，给「审批与异常分诊」窗口做分诊台账（前端展示用）。 */
export interface DecisionRecord {
  id: string;
  title: string;
  kind: ApprovalDecisionInput["kind"];
  decision: ApprovalDecisionInput["decision"];
  status: string;
  note?: string;
  at: string;
}

export interface AppState {
  activeWindow: WindowKey;
  customers: Customer[];
  samples: FabricSample[];
  queue: ApprovalItem[];
  panorama: PanoramaSnapshot | null;
  decisions: DecisionRecord[];
  loading: boolean;
  globalError: string | null;

  setActiveWindow: (window: WindowKey) => void;
  /** 一次拉取全部只读数据；审批队列的「实时更新」由此驱动。 */
  refresh: () => Promise<void>;
  decide: (input: ApprovalDecisionInput) => Promise<ApprovalDecisionResult>;
  /** 建客户 / 建样品：主数据录入，成功后立刻刷新目录与全景。 */
  createCustomer: (body: CreateCustomerInput) => Promise<Customer>;
  createSample: (body: CreateSampleInput) => Promise<FabricSample>;
  generateQuoteDraft: (body: T004GenerateQuoteDraftInput) => Promise<T004GenerateQuoteDraftResult>;
  createSampleShipment: (
    body: T005CreateSampleShipmentInput,
  ) => Promise<T005CreateSampleShipmentResult>;
  searchBySpec: (body: T002SearchFabricBySpecInput) => Promise<T002SearchFabricBySpecResult>;
}

export const useAppStore = create<AppState>()((set, get) => ({
  activeWindow: "intent",
  customers: [],
  samples: [],
  queue: [],
  panorama: null,
  decisions: [],
  loading: true,
  globalError: null,

  setActiveWindow: (activeWindow) => set({ activeWindow }),

  refresh: async () => {
    // pnpm dev 下 API(3000) 可能比 Vite(5173) 晚就绪，给首屏几次短暂重试。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [customers, samples, queue, panorama] = await Promise.all([
          apiClient.customers(),
          apiClient.samples(),
          apiClient.queue(),
          apiClient.panorama(),
        ]);
        set({
          customers: customers.customers,
          samples: samples.samples,
          queue: queue.items,
          panorama,
          loading: false,
          globalError: null,
        });
        return;
      } catch (error) {
        if (attempt === 2) {
          set({ loading: false, globalError: messageOf(error) });
        } else {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 700);
          });
        }
      }
    }
  },

  decide: async (input) => {
    const result = await apiClient.decide(input);
    if (result.ok) {
      const title = get().queue.find((item) => item.id === input.id)?.title ?? shortId(input.id);
      const record: DecisionRecord = {
        id: result.data.id,
        title,
        kind: result.data.kind,
        decision: result.data.decision,
        status: result.data.status,
        note: input.note,
        at: result.data.decidedAt,
      };
      set((state) => ({ decisions: [record, ...state.decisions].slice(0, 30) }));
      await get().refresh();
    }
    return result;
  },

  createCustomer: async (body) => {
    const result = await apiClient.createCustomer(body);
    await get().refresh();
    return result.data;
  },

  createSample: async (body) => {
    const result = await apiClient.createSample(body);
    await get().refresh();
    return result.data;
  },

  generateQuoteDraft: async (body) => {
    const result = await apiClient.generateQuoteDraft(body);
    if (result.ok) await get().refresh();
    return result;
  },

  createSampleShipment: async (body) => {
    const result = await apiClient.createSampleShipment(body);
    if (result.ok) await get().refresh();
    return result;
  },

  searchBySpec: (body) => apiClient.searchBySpec(body),
}));
