/**
 * scripts/dev.mjs 的纯逻辑用例（不发进程、不占端口）。
 *
 * 只守两类容易悄悄坏掉的东西：
 *   1. 端注册表——端口重复 / health 路径写错，最终表现为「表里有个地址打不开」；
 *   2. 表格渲染——中文标签按 2 列算宽，否则清单在终端里参差不齐。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SERVICES, displayWidth, parseArgs, renderTable, selectServices } from "./dev.mjs";

test("每个端有唯一 key 与唯一端口", () => {
  const keys = SERVICES.map((service) => service.key);
  const ports = SERVICES.map((service) => service.port);
  assert.equal(new Set(keys).size, keys.length, `重复的 key：${keys.join(", ")}`);
  assert.equal(new Set(ports).size, ports.length, `重复的端口：${ports.join(", ")}`);
});

test("每个端的地址与 health 路径可直接拼成 URL", () => {
  for (const service of SERVICES) {
    assert.match(service.baseUrl, /^http:\/\/localhost:\d+$/, `${service.key} baseUrl 不合法`);
    assert.ok(service.healthPath.startsWith("/"), `${service.key} healthPath 必须以 / 开头`);
    assert.equal(new URL(`${service.baseUrl}${service.healthPath}`).port, String(service.port));
  }
});

test("mobile 用 Taro 自带的 H5 dev server（10086），不额外补静态服务", () => {
  const mobile = SERVICES.find((service) => service.key === "mobile");
  assert.ok(mobile);
  assert.equal(mobile.port, 10086);
  assert.equal(mobile.healthPath, "/");
  assert.equal(mobile.commands, undefined);
});

test("默认选中全部 URL 端，--no-mobile 只去掉移动端", () => {
  const all = selectServices(parseArgs([]));
  assert.deepEqual(
    all.map((service) => service.key),
    SERVICES.map((service) => service.key),
  );
  const withoutMobile = selectServices(parseArgs(["--no-mobile"]));
  assert.ok(!withoutMobile.some((service) => service.key === "mobile"));
  assert.equal(withoutMobile.length, SERVICES.length - 1);
});

test("按名字选端，未知名字报错", () => {
  assert.deepEqual(
    selectServices(parseArgs(["web", "api"])).map((service) => service.key),
    ["api", "web"],
  );
  assert.throws(() => selectServices(parseArgs(["nope"])), /未知的端/);
});

test("表格每行显示宽度一致，且包含所有地址与 health 端点", () => {
  const states = new Map(
    SERVICES.map((service) => [service.key, { status: "ready", httpStatus: 200 }]),
  );
  const table = renderTable(SERVICES, states);
  const widths = table.split("\n").map((line) => displayWidth(line));
  assert.equal(new Set(widths).size, 1, "表格各行宽度不一致");
  for (const service of SERVICES) {
    assert.ok(table.includes(service.baseUrl), `缺少地址 ${service.baseUrl}`);
    assert.ok(table.includes(service.healthPath), `缺少 health ${service.healthPath}`);
  }
});

test("中文按两列宽计算", () => {
  assert.equal(displayWidth("工作台"), 6);
  assert.equal(displayWidth("工作台 web"), 10);
});
