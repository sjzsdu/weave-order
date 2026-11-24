import { expect, test } from "../../support/test";
import { readSeed } from "../../support/seed";
import { noHorizontalScroll, openSample, screenshotViewport } from "../../support/ui";

const ZPL_PRINTER_ID = "123e4567-e89b-12d3-a456-426614174020";
const TSPL_PRINTER_ID = "123e4567-e89b-12d3-a456-426614174021";
const AGENT_ID = "123e4567-e89b-12d3-a456-426614174022";
const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALkAAAC5CAYAAAB0rZ5cAAAAAklEQVR4AewaftIAAAVfSURBVO3BUW4cSxIEQY/E3P/Kvu9/qwWU0CLFVJgFkB9G5S1JeKJykoQTlTcl4UTlJAlvUXmShJ9kqFpuqFpuqFpuqFpuqFpuqFpuqFruwy+ofKckvCUJt5LwliR8J5WTJLxF5Tsl4WSoWm6oWm6oWm6oWm6oWm6oWu7Db0jCW1TelIQbKk+ScKLyFpW3qDxJwonKV0jCW1RuDFXLDVXLDVXLDVXLDVXLDVXLffhHqNxSOUnCd0rCicoTlZMknKhsMVQtN1QtN1QtN1QtN1Qt9+EfkYQTlSdJeIvKrSTcSEL9v6FquaFquaFquaFquaFquQ+/QeVfoHKShFtJeIvKW5LwFVS+y1C13FC13FC13FC13FC13FC13IdfSMIWKidJeKJyQ+VJEk5UniThRhKeqPxpSfgbDVXLDVXLDVXLDVXLDVXLxf+wSBL+NJWvkIQTlVtJuKGyxVC13FC13FC13FC13FC13FC1XAB5oHKShO+k8p2ScKLyFZJwovIkCScqt5LwnVRuDFXLDVXLDVXLDVXLDVXLfVRuqdxKwonKm5JwonKShLck4YnKrSScqGyh8pYknAxVyw1Vyw1Vyw1Vyw1VywWQByonSXiiciMJt1S+UxK+gsqNJDxRuZGEJyonSbil8qcNVcsNVcsNVcsNVcsNVcsNVct9eFkS3qJyKwk3VG6pnCThicpJEp4k4UTlLUn4CionSThReZKEE5WToWq5oWq5oWq5oWq5oWq5APKNVJ4k4ZbKjSQ8UXlLEv40lVtJOFH5Ckm4pXJjqFpuqFpuqFpuqFpuqFou/ocXJeFE5SQJT1ROkvBE5SQJJyq3knCi8qYkbKfyliScDFXLDVXLDVXLDVXLDVXLDVXLfZJwS+UrJOFE5S1JeKLypyXhlspbknCi8iQJb0nCLZUTlZOharmharmharmharmharkPL1M5ScKJypuScKJyKwknKreScKLyJAk3knBL5SQJT1RuJeFE5VYSTlROhqrlhqrlhqrlhqrlhqrlPvyCykkSnqi8JQknKreScKLyFVRuqZwk4UTlVhJOVN6kcpKEWyo3hqrlhqrlhqrlhqrlhqrlAshfSuVWEk5UTpLwnVTekoSfRuUkCU9UTpJwMlQtN1QtN1QtN1QtN1QtF0AeqJwk4YnKjSS8SeUkCScqT5LwnVT+tCScqLwpCScqJ0l4onJjqFpuqFpuqFpuqFpuqFpuqFruw29QeZKEGyq3kvAVVG4k4YnKSRKeJOFE5adRuaHyJAknKidD1XJD1XJD1XJD1XIB5IHKSRKeqJwk4adReUsSbqmcJOGWykkSvpPKSRLeMlQtN1QtN1QtN1QtN1QtF//DIkk4UflpkvAWlZMknKi8KQnfZahabqhabqhabqhabqhabqha7pOEn0blicpJEk5UbiXhROVWEp6ovCUJb0nCicpXULkxVC03VC03VC03VC03VC334RdUvlMSbiXhRhKeqJyo3ErCicpPo/IWlVtJuDFULTdULTdULTdULTdULTdULffhNyThLSpfQeU7qZwk4S0qT1ROknCShO+UhCcqN4aq5Yaq5Yaq5Yaq5Yaq5T7845JwS+VWEk5UniThROUkCU9UTlROkvBE5SQJT1ROknArCTeGquWGquWGquWGquWGquU+/ONUniThJAm3VE6ScCsJt5JwonIrCbeS8KepnAxVyw1Vyw1Vyw1Vyw1Vyw1Vy334DSp/K5UbSfhbqbwlCSdJOFF5koQ/TeVJEm4MVcsNVcsNVcsNVcsNVct9+IUk/DRJ+NNUbiXhLUk4UbmlcpKEr6BykoQnKjeGquWGquWGquWGquWGquX+B8daEogjgsx7AAAAAElFTkSuQmCC";

function printer(id: string, name: string, format: "ZPL" | "TSPL", status = "READY") {
  return {
    id,
    agentId: AGENT_ID,
    name,
    kind: "THERMAL",
    connection: "RAW_TCP",
    address: null,
    capabilities: { format },
    calibration: {},
    status,
    lastSeenAt: null,
  };
}

function preview(sample: { id: string; code: string }, format: "ZPL" | "TSPL") {
  return {
    kind: "SAMPLE_LABEL",
    quoteId: null,
    sampleId: sample.id,
    lineIndex: 0,
    format,
    templateName: `系统 · 样卡标签（${format} 80×50）`,
    pageSize: "80x50",
    isSystem: true,
    sampleCode: sample.code,
    qrPayload: "https://example.test/sample-card/token",
    html: null,
    pdfBase64: null,
    text:
      format === "ZPL"
        ? `^XA\n^PW640\n^LL400\n^FD${"LONG-INSTRUCTION-".repeat(100)}^FS\n^XZ`
        : `SIZE 80 mm,50 mm\nTEXT 20,44,"TSS24.BF2",0,1,1,"${"LONG-INSTRUCTION-".repeat(100)}"\nPRINT 1,1`,
    fields: [{ path: "sample.code", label: "样品编号", value: sample.code }],
    labelPreview: {
      width: 640,
      height: 400,
      elements: [
        { type: "text", x: 24, y: 12, text: "织序纺织", fontSize: 26, bold: true },
        { type: "rect", x: 24, y: 44, width: 592, height: 2 },
        { type: "text", x: 24, y: 52, text: sample.code, fontSize: 30, bold: true },
        { type: "qr", x: 24, y: 150, size: 180, dataUrl: QR_DATA_URL },
      ],
    },
  };
}

test("样品标签提供可视预览、具体打印机选择且各宽度不裁切", async ({ page }, testInfo) => {
  const seed = await readSeed();
  const sample = seed.fabricSamples[0];
  if (!sample) throw new Error("缺少种子样品");

  const previewPrinterIds: string[] = [];
  let printBody: Record<string, unknown> | null = null;
  await page.route("**/api/print/devices", (route) =>
    route.fulfill({
      json: {
        agents: [],
        printers: [
          printer(ZPL_PRINTER_ID, "仓库斑马", "ZPL"),
          printer(TSPL_PRINTER_ID, "仓库 TSC", "TSPL"),
          { ...printer("123e4567-e89b-12d3-a456-426614174023", "办公室 A4", "ZPL"), kind: "A4" },
        ],
      },
    }),
  );
  await page.route("**/api/print/sample-labels/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/preview")) {
      const body = request.postDataJSON() as { printerId: string };
      previewPrinterIds.push(body.printerId);
      await route.fulfill({
        json: {
          preview: preview(sample, body.printerId === TSPL_PRINTER_ID ? "TSPL" : "ZPL"),
        },
      });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    printBody = body;
    const format = body.printerId === TSPL_PRINTER_ID ? "TSPL" : "ZPL";
    await route.fulfill({
      json: {
        deduplicated: false,
        job: {
          id: "123e4567-e89b-12d3-a456-426614174024",
          kind: "SAMPLE_LABEL",
          documentId: sample.id,
          orderId: null,
          shipmentId: null,
          boxId: null,
          labelSeq: 1,
          templateVersion: 1,
          format,
          copies: body.copies,
          priority: 0,
          status: "QUEUED",
          isTest: false,
          idempotencyKey: "sample-label-e2e",
          reprintReason: null,
          requestedBy: "owner",
          attempts: 0,
          lastError: null,
          printerId: body.printerId,
          agentId: AGENT_ID,
          snapshotId: null,
          createdAt: "2026-11-23T00:00:00.000Z",
          completedAt: null,
        },
      },
    });
  });

  await openSample(page, sample);
  await page.locator("aside").getByRole("button", { name: "打印标签", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "打印样品标签" });
  const visual = dialog.getByTestId("sample-label-visual-preview");
  await expect(visual).toBeVisible();
  await expect(visual).toHaveAttribute("viewBox", "0 0 640 400");
  await expect(visual).toContainText(sample.code);
  await expect(visual.locator("image")).toHaveCount(1);
  await expect(dialog.getByLabel("标签打印机")).toHaveValue(ZPL_PRINTER_ID);
  await expect(dialog.getByLabel("标签打印机").locator("option")).toHaveCount(2);
  await expect(dialog.getByText("A4 样卡", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("下载 A4 PDF", { exact: true })).toHaveCount(0);

  const tsplRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/print/sample-labels/") &&
      request.url().endsWith("/preview") &&
      request.postDataJSON()?.printerId === TSPL_PRINTER_ID,
  );
  await dialog.getByLabel("标签打印机").selectOption(TSPL_PRINTER_ID);
  await tsplRequest;
  await expect(dialog.getByText("TSPL · 80×50mm 标签效果预览", { exact: true })).toBeVisible();
  expect(previewPrinterIds).toEqual([ZPL_PRINTER_ID, TSPL_PRINTER_ID]);

  const printRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/print\/sample-labels\/[^/]+$/.test(new URL(request.url()).pathname),
  );
  await dialog.getByRole("button", { name: "打印", exact: true }).click();
  await printRequest;
  expect(printBody).toMatchObject({ printerId: TSPL_PRINTER_ID, copies: 1 });
  await expect(dialog.getByRole("status")).toContainText("已入队到 仓库 TSC");
  await screenshotViewport(page, testInfo, "sample-label-preview");

  await dialog.getByText("查看打印指令", { exact: true }).click();
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await dialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const button =
        element.querySelector("button.bg-ink-900") ??
        [...element.querySelectorAll("button")].find((item) => item.textContent === "打印");
      const buttonRect = button?.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        dialogLeft: dialogRect.left,
        dialogRight: dialogRect.right,
        buttonLeft: buttonRect?.left ?? null,
        buttonRight: buttonRect?.right ?? null,
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.buttonLeft).not.toBeNull();
    expect(metrics.buttonLeft!).toBeGreaterThanOrEqual(metrics.dialogLeft);
    expect(metrics.buttonRight!).toBeLessThanOrEqual(metrics.dialogRight);
    await noHorizontalScroll(page);
  }
});
