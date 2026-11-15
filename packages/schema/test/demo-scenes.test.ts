import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DemoSceneFile, demoSceneByKey } from "../src/demo";

/** 仓库根的剧本文件是唯一事实源：销售深链、e2e 断言、服务端解析都读它。 */
const FILE = path.resolve(__dirname, "../../../data/demo-scenes.json");

function load() {
  return DemoSceneFile.parse(JSON.parse(readFileSync(FILE, "utf8")));
}

describe("data/demo-scenes.json", () => {
  it("通过契约校验且 key 唯一", () => {
    const parsed = load();
    const keys = parsed.scenes.map((scene) => scene.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每份剧本都有可分享的深链，且与 key 一致", () => {
    for (const scene of load().scenes) {
      expect(scene.href).toContain(`?scene=${scene.key}`);
      expect(scene.href.startsWith("/today")).toBe(true);
    }
  });

  it("锚点只引用审批中心支持的两类单据", () => {
    for (const scene of load().scenes) {
      expect(["quote", "sample_shipment"]).toContain(scene.anchor.kind);
      expect(scene.anchor.customerCode).toBe("DEMO-SCENE-001");
    }
  });

  it("demoSceneByKey 找不到时返回 null（服务端转 404）", () => {
    const scenes = load().scenes;
    expect(demoSceneByKey(scenes, "approval-pending")?.key).toBe("approval-pending");
    expect(demoSceneByKey(scenes, "missing")).toBeNull();
  });
});
