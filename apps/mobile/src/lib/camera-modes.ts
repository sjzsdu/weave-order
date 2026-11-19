import type { CameraMode } from "./entry-params";

/**
 * 相机的「能力」规格表：每个 mode 自带标题、字段与拍摄后去向。
 *
 * 相机不再是一个「先选模式」的目的地：入口（报价页拍布、待办任务卡、我的里的
 * 现场动作兜底）决定 mode，页面只按这张表渲染，UI 里不再出现模式宫格。
 */

/** 模式页面上要出现的输入字段；不在这张表里的字段一律不渲染。 */
export type CameraField = "tracking" | "note";

/** 拍摄后的去向：找样检索 / 建样品 / 取证入队 / 只是录入单号。 */
export type CameraOutcome = "find" | "sample" | "proof" | "input";

export type ProofKind = "SIGNATURE" | "CARGO" | "RECEIPT";

export interface CameraModeSpec {
  title: string;
  subtitle: string;
  desc: string;
  outcome: CameraOutcome;
  /** 拍摄按钮文案；`input` 模式不用它。 */
  captureLabel: string;
  fields: readonly CameraField[];
  /** 取证模式上传时使用的 proof kind（样例模式用 SAMPLE，其余为空）。 */
  proofKind?: ProofKind;
  /** 空态提示：拍完之后这块会变成结果。 */
  emptyHint: string;
  /**
   * 只有小程序能做的动作对应的文案（如扫码）。
   * H5 页面必须完全不出现「扫码」——按钮、标题、正文都算，所以文案本身也要分端。
   */
  weapp?: { subtitle: string; desc: string };
}

export const CAMERA_MODE_SPECS: Record<CameraMode, CameraModeSpec> = {
  find: {
    title: "找样",
    subtitle: "拍一张布，找同款",
    desc: "只拍面料本身：拍完直接出候选，点一张就能带进报价。",
    outcome: "find",
    captureLabel: "拍照找样",
    // 找样不需要运单号 / 备注：这两项属于取证任务，放在这里只会让人多填。
    fields: [],
    emptyHint: "拍一张光线均匀的布面，候选按相似度排序。",
  },
  sample: {
    title: "建样品",
    subtitle: "拍布建样，其余后补",
    desc: "品名必填，成分与克重可以先留空，之后在样品图墙补。",
    outcome: "sample",
    captureLabel: "拍照建样",
    fields: [],
    emptyHint: "拍一张代表这块布的正面，代码会自动生成。",
  },
  waybill: {
    title: "录入运单号",
    // H5 没有条码能力：这里的文案一个字都不能提「扫码」，按钮与正文共用同一套。
    subtitle: "手工录入",
    desc: "浏览器没有条码能力，手工录入运单号。",
    outcome: "input",
    captureLabel: "录入运单号",
    fields: [],
    emptyHint: "运单号只存在本地，接入单号查询后自动提交。",
    weapp: {
      subtitle: "手输或扫码",
      desc: "小程序可以直接扫码，也可以手工录入。",
    },
  },
  signature: {
    title: "拍签收",
    subtitle: "签收单回传",
    desc: "签收单要和运单号一起留档，拍照后自动上传。",
    outcome: "proof",
    captureLabel: "拍签收单",
    fields: ["tracking", "note"],
    proofKind: "SIGNATURE",
    emptyHint: "签收人、日期要能看清，离线时会先存本地队列。",
  },
  cargo: {
    title: "拍大货",
    subtitle: "生产进度留档",
    desc: "拍大货现场，留一句进度说明即可。",
    outcome: "proof",
    captureLabel: "拍大货",
    fields: ["note"],
    proofKind: "CARGO",
    emptyHint: "拍清数量和工序，按时间序上传。",
  },
  receipt: {
    title: "拍回款",
    subtitle: "回款凭证留档",
    desc: "拍回款凭证，金额与时间写进备注。",
    outcome: "proof",
    captureLabel: "拍回款凭证",
    fields: ["note"],
    proofKind: "RECEIPT",
    emptyHint: "凭证四角要完整，离线时先存本地队列。",
  },
};

export function cameraModeSpec(mode: CameraMode, isWeapp = false): CameraModeSpec {
  const spec = CAMERA_MODE_SPECS[mode];
  if (!isWeapp || !spec.weapp) return spec;
  return { ...spec, subtitle: spec.weapp.subtitle, desc: spec.weapp.desc };
}

export function cameraFieldVisible(mode: CameraMode, field: CameraField): boolean {
  return CAMERA_MODE_SPECS[mode].fields.includes(field);
}

/** H5 没有条码能力：只有小程序端才出现「扫码」字样。 */
export function waybillActionLabel(isWeapp: boolean): string {
  return isWeapp ? "扫码录入" : "录入运单号";
}
