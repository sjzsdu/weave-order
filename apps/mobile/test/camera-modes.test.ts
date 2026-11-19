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
});
