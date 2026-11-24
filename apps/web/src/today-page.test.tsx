import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntentEntry, RunningEmptyState } from "./today-page";

/**
 * WAN-212 走查抓到的第二处矛盾：「正在进行」写「小织还没接到活」，
 * 旁边却写着「2 件等你决定」。草稿在等批就是活，只是卡在人这一环。
 * 两条空态必须分开说，各说各的真话。
 */
describe("工作台「正在进行」空态", () => {
  it("有待办时说它在等人决定，并把人送到待决定列表", () => {
    const html = renderToStaticMarkup(<RunningEmptyState pendingCount={2} />);

    expect(html).toContain("小织在等你决定 2 件，决定完它继续");
    expect(html).not.toContain("还没接到活");
    expect(html).toContain('href="#decisions"');
  });

  it("没有待办时才说还没接到活，并给一个开工动作", () => {
    const html = renderToStaticMarkup(<RunningEmptyState pendingCount={0} />);

    expect(html).toContain("小织还没接到活，先给它一个客户或样品");
    expect(html).not.toContain("等你决定");
    expect(html).toContain('href="/panorama/customers"');
  });

  it("件数跟着传入的待办数走", () => {
    expect(renderToStaticMarkup(<RunningEmptyState pendingCount={7} />)).toContain("等你决定 7 件");
  });
});

/**
 * 第三处矛盾：工作台是对小织说话的默认落地页，却找不到一个理所当然的开口处。
 * 入口必须是一个真链接（可聚焦、可新标签打开），且落到有完整 composer 的面板。
 */
describe("工作台意图入口", () => {
  it("整宽入口指向小织面板并自动聚焦", () => {
    const html = renderToStaticMarkup(<IntentEntry />);

    expect(html).toContain('href="/xiaozhi?compose=1"');
    expect(html).toContain("<a");
    expect(html).toContain("说句话，小织就开工");
  });

  it("不把内部术语暴露给用户", () => {
    const html = [
      renderToStaticMarkup(<IntentEntry />),
      renderToStaticMarkup(<RunningEmptyState pendingCount={3} />),
      renderToStaticMarkup(<RunningEmptyState pendingCount={0} />),
    ].join("");

    expect(html).not.toMatch(/pending|stats|IN_PROGRESS|inbound/i);
  });
});
