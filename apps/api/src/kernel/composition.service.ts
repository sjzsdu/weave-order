import { CompositionParts, CompositionPartsInput, compositionText } from "@weave-order/schema";
import type { CompositionParts as CompositionPartsType } from "@weave-order/schema";
import { KernelError } from "./errors";
import type { FieldOptionsService } from "./field-options.service";

/**
 * 成分解析：把「用户填了什么」变成「库里存什么」。
 *
 * 两条路互斥，判定只在这里发生：
 * - **配比模式**：客户端给 `[{code, percent}]`，本服务校验原料 code 属于本租户的
 *   「样品原料」字典、取字典当前名称当快照、按百分比降序派生成分文本。
 * - **文本模式**：客户端给原文，直接存；配比清空。
 *
 * 为什么要服务端派生文本：客户端同时能写文本和配比时，两份口径必然漂移
 * （样卡上印「55% 麻 45% 棉」，库里配比却是 60/40）。派生之后只有一份真相。
 * 原料名称也由服务端从字典取 —— 客户端自造原料名会绕过字典治理，
 * 让「这个原料到底叫什么」永远对不上账。
 */
export class CompositionService {
  constructor(private readonly options: FieldOptionsService) {}

  /**
   * 配比输入 → 落库形态。
   *
   * 合计必须正好 100%（契约层已判），这里再判一次原料是否认识：
   * 字典里没有的 code 一律拒，不当成「未知原料」塞进库里。
   */
  async resolveParts(input: unknown): Promise<CompositionPartsType> {
    const parsed = CompositionPartsInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new KernelError("KERNEL_REJECTED", issue?.message ?? "成分配比不合法", {
        reason: "COMPOSITION_PARTS_INVALID",
      });
    }
    // 含停用原料：停用只是「不再出现在下拉里」，历史样品仍要能编辑。
    const materials = await this.options.list("sample.material", true);
    const byCode = new Map(materials.map((material) => [material.code, material]));
    const parts = parsed.data.map((part) => {
      const material = byCode.get(part.code);
      if (!material) {
        throw new KernelError("KERNEL_REJECTED", `未知原料：${part.code}`, {
          reason: "COMPOSITION_MATERIAL_UNKNOWN",
        });
      }
      return { code: material.code, label: material.label, percent: part.percent };
    });
    return CompositionParts.parse(parts);
  }

  /**
   * 一次写入的成分落库形态。
   *
   * 给了配比就以配比为准并派生文本；只给文本（或都为空）就是文本模式，配比清空。
   */
  async resolve(input: {
    text?: string | null;
    parts?: unknown;
  }): Promise<{ composition: string | null; compositionParts: CompositionPartsType | null }> {
    if (input.parts !== undefined && input.parts !== null) {
      const parts = await this.resolveParts(input.parts);
      return { composition: compositionText(parts), compositionParts: parts };
    }
    const text = input.text?.trim();
    return { composition: text ? text : null, compositionParts: null };
  }
}
