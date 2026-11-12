import Taro from "@tarojs/taro";
import { IS_H5, IS_RN, IS_WEAPP } from "./runtime";

/**
 * 大额审批二次验证。
 *
 * - 小程序：微信 Soter（指纹 / 面容）；
 * - App（RN）：宿主注入的原生生物识别模块，未注入时 fail-closed（不许批）；
 * - H5：浏览器没有可用的生物识别注册流程，退化为明确的一次确认，
 *   并在结果里标注方法，审计能看到「不是 Face ID」。
 */

export type VerifyMethod = "not-required" | "soter" | "native" | "confirm" | "blocked";

export interface VerifyResult {
  verified: boolean;
  method: VerifyMethod;
  message?: string;
}

interface NativeBiometrics {
  authenticate(reason: string): Promise<boolean>;
}

interface SoterApi {
  checkIsSupportSoterAuthentication(): Promise<{ supportMode: string[] }>;
  startSoterAuthentication(options: {
    requestAuthModes: string[];
    challenge: string;
    authContent: string;
  }): Promise<{ errCode: number; errMsg: string }>;
}

async function verifyNative(): Promise<VerifyResult> {
  const native = (globalThis as { WeaveBiometrics?: NativeBiometrics }).WeaveBiometrics;
  if (!native) {
    return {
      verified: false,
      method: "blocked",
      message: "App 端未接入生物识别模块，大额审批请到已认证设备处理",
    };
  }
  const ok = await native.authenticate("大额审批二次验证");
  return ok
    ? { verified: true, method: "native" }
    : { verified: false, method: "native", message: "生物识别未通过" };
}

async function verifySoter(): Promise<VerifyResult> {
  const soter = Taro as unknown as SoterApi;
  try {
    const support = await soter.checkIsSupportSoterAuthentication();
    const modes = support.supportMode.includes("facial")
      ? ["facial", "fingerPrint"]
      : support.supportMode.includes("fingerPrint")
        ? ["fingerPrint"]
        : [];
    if (modes.length === 0) {
      return { verified: false, method: "blocked", message: "当前设备不支持生物识别" };
    }
    const result = await soter.startSoterAuthentication({
      requestAuthModes: modes,
      challenge: `weave-${Date.now()}`,
      authContent: "织序大额审批",
    });
    return result.errCode === 0
      ? { verified: true, method: "soter" }
      : { verified: false, method: "soter", message: "生物识别未通过" };
  } catch {
    return { verified: false, method: "blocked", message: "生物识别不可用" };
  }
}

export async function verifyLargeAmount(
  amountCents: number,
  thresholdCents: number,
): Promise<VerifyResult> {
  if (amountCents <= thresholdCents) return { verified: true, method: "not-required" };
  if (IS_WEAPP) return verifySoter();
  if (IS_RN) return verifyNative();
  if (IS_H5) {
    const result = await Taro.showModal({
      title: "大额审批二次确认",
      content: `本单 ¥${(amountCents / 100).toFixed(2)} 超过你的阈值。H5 无 Face ID，请确认是本人操作；App 端将要求 Face ID。`,
      confirmText: "确认批",
      cancelText: "取消",
    });
    return result.confirm
      ? { verified: true, method: "confirm" }
      : { verified: false, method: "confirm", message: "已取消" };
  }
  return { verified: false, method: "blocked", message: "当前端不支持大额审批" };
}
