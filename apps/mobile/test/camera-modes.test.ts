import { describe, expect, it } from "vitest";
import {
  CAMERA_MODE_SPECS,
  cameraFieldVisible,
  cameraModeSpec,
  waybillActionLabel,
} from "../src/lib/camera-modes";
import { CAMERA_MODES } from "../src/lib/entry-params";

/**
 * 相机是「能力」不是目的地：页面不再有模式宫格，每个 mode 的字段必须自报家门。
 * 这里守住最容易回归的两件事：每个 mode 都有文案，找样/建样不许再长回运单号。
 */
describe("相机 mode 规格", () => {
  it("CAMERA_MODES 的每个 mode 都有完整规格", () => {
    for (const mode of CAMERA_MODES) {
      const spec = CAMERA_MODE_SPECS[mode];
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.subtitle.length).toBeGreaterThan(0);
      expect(spec.desc.length).toBeGreaterThan(0);
      expect(spec.emptyHint.length).toBeGreaterThan(0);
      expect(spec.captureLabel.length).toBeGreaterThan(0);
    }
  });

  it("找样与建样不再出现运单号 / 备注字段", () => {
    expect(cameraModeSpec("find").fields).toEqual([]);
    expect(cameraModeSpec("sample").fields).toEqual([]);
    expect(cameraFieldVisible("find", "tracking")).toBe(false);
    expect(cameraFieldVisible("find", "note")).toBe(false);
  });

  it("取证模式只带自己的字段", () => {
    // 签收单要能对上运单号；大货与回款只要一句说明。
    expect(cameraModeSpec("signature").fields).toEqual(["tracking", "note"]);
    expect(cameraModeSpec("cargo").fields).toEqual(["note"]);
    expect(cameraModeSpec("receipt").fields).toEqual(["note"]);
  });

  it("取证模式各自映射到唯一 proof kind", () => {
    expect(cameraModeSpec("signature").proofKind).toBe("SIGNATURE");
    expect(cameraModeSpec("cargo").proofKind).toBe("CARGO");
    expect(cameraModeSpec("receipt").proofKind).toBe("RECEIPT");
    // 找样/建样/录单号不是取证，不能悄悄写一条 proof。
    expect(cameraModeSpec("find").proofKind).toBeUndefined();
    expect(cameraModeSpec("sample").proofKind).toBeUndefined();
    expect(cameraModeSpec("waybill").proofKind).toBeUndefined();
  });

  it("H5 只说「录入运单号」，只有小程序出现「扫码」", () => {
    expect(waybillActionLabel(false)).toBe("录入运单号");
    expect(waybillActionLabel(false)).not.toContain("扫");
    expect(waybillActionLabel(true)).toContain("扫");
    expect(cameraModeSpec("waybill").outcome).toBe("input");
  });

  it("H5 的运单号页文案（subtitle / desc）不含「扫码」", () => {
    // 按钮文案对了不代表页面文案对了：副标题与正文曾经写着「手输或扫码」，
    // H5 用户照样会看到「扫码」，且点了也扫不了。
    for (const mode of CAMERA_MODES) {
      const h5 = cameraModeSpec(mode, false);
      expect(h5.subtitle).not.toContain("扫码");
      expect(h5.desc).not.toContain("扫码");
      expect(h5.emptyHint).not.toContain("扫码");
    }
    const waybill = cameraModeSpec("waybill", false);
    expect(waybill.subtitle).toContain("录入");
    expect(waybill.desc).toContain("录入运单号");
  });

  it("小程序端运单号页才出现扫码文案", () => {
    const weapp = cameraModeSpec("waybill", true);
    expect(weapp.subtitle).toContain("扫码");
    expect(weapp.desc).toContain("扫码");
    // 没写 weapp 文案的 mode 不受影响。
    expect(cameraModeSpec("find", true)).toEqual(cameraModeSpec("find", false));
  });
});
