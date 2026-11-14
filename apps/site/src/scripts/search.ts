/**
 * 织序 WeaveOrder · 站内搜索（DOM 部分）
 *
 * 纯前端：构建期生成 /search-index.json，浏览器本地匹配，不联网、不埋点。
 * 匹配与打分在 src/lib/search.ts（纯函数，可单测），这里只负责对话框与交互。
 *
 * 入口：页头「搜索」按钮、⌘K / Ctrl+K、`/`、以及 `?q=报价` 直接打开。
 * 不依赖框架：禁用 JS 时导航与内容照常可用，只是搜索按钮不响应。
 */

import { searchPages } from "../lib/search";
import type { SearchHit, SearchPage } from "../lib/search";

const INDEX_URL = "/search-index.json";

let indexPromise: Promise<SearchPage[]> | null = null;
let pages: SearchPage[] = [];
let hits: SearchHit[] = [];
let active = -1;

const dialog = document.getElementById("siteSearch");
const input = document.getElementById("searchInput") as HTMLInputElement | null;
const list = document.getElementById("searchResults");
const status = document.getElementById("searchStatus");
let lastTrigger: HTMLElement | null = null;

function loadIndex(): Promise<SearchPage[]> {
  indexPromise ??= fetch(INDEX_URL, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`index ${response.status}`);
      return response.json() as Promise<{ pages?: SearchPage[] }>;
    })
    .then((data) => {
      pages = data.pages ?? [];
      return pages;
    })
    .catch(() => {
      pages = [];
      return pages;
    });
  return indexPromise;
}

function render(): void {
  if (!list || !input || !status) return;
  list.replaceChildren();
  const query = input.value.trim();

  if (!query) {
    status.textContent = "输入关键词：报价、导入、审批、打印、发票、邀请同事…";
    return;
  }
  if (!pages.length) {
    status.textContent =
      "搜索索引还没准备好（开发环境如此）。可以先看帮助中心的目录，或直接问同事。";
    return;
  }
  if (!hits.length) {
    status.textContent = `没有找到「${query}」。换个说法试试：报价、改价、打印、发票、邀请同事。`;
    return;
  }

  status.textContent = `找到 ${hits.length} 条结果`;
  hits.forEach((hit, position) => {
    const link = document.createElement("a");
    link.className = `search__hit${position === active ? " is-active" : ""}`;
    link.href = `${hit.url}${hit.anchor}`;
    link.id = `search-hit-${position}`;
    link.setAttribute("role", "option");
    link.setAttribute("aria-selected", position === active ? "true" : "false");

    const head = document.createElement("span");
    head.className = "search__hit-title";
    head.textContent = hit.title;
    link.appendChild(head);

    if (hit.section) {
      const crumb = document.createElement("span");
      crumb.className = "search__hit-section";
      crumb.textContent = hit.section;
      link.appendChild(crumb);
    }

    const text = document.createElement("span");
    text.className = "search__hit-snippet";
    text.textContent = hit.snippet;
    link.appendChild(text);

    link.addEventListener("mouseenter", () => {
      active = position;
      render();
    });
    list.appendChild(link);
  });
}

function run(): void {
  if (!input) return;
  hits = searchPages(pages, input.value);
  active = hits.length ? 0 : -1;
  render();
  input.setAttribute("aria-activedescendant", active >= 0 ? `search-hit-${active}` : "");
}

async function open(initial?: string): Promise<void> {
  if (!dialog || !input) return;
  if (!dialog.hidden) {
    if (typeof initial === "string") {
      input.value = initial;
      run();
    }
    return;
  }
  lastTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.hidden = false;
  document.documentElement.classList.add("search-open");
  input.value = initial ?? "";
  input.focus();
  if (input.value) input.select();
  // 先把对话框亮出来再等索引：慢网络下点「搜索」不会有空白等待。
  if (status) status.textContent = "正在准备搜索…";
  await loadIndex();
  run();
}

function close(): void {
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  document.documentElement.classList.remove("search-open");
  if (lastTrigger && typeof lastTrigger.focus === "function") lastTrigger.focus();
}

function move(delta: number): void {
  if (!hits.length) return;
  active = (active + delta + hits.length) % hits.length;
  render();
  document.getElementById(`search-hit-${active}`)?.scrollIntoView({ block: "nearest" });
  input?.setAttribute("aria-activedescendant", `search-hit-${active}`);
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

  if (event.key === "Escape") {
    if (dialog && !dialog.hidden) {
      event.preventDefault();
      close();
    }
    return;
  }

  const openShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  const slashShortcut = event.key === "/" && !typing && !event.metaKey && !event.ctrlKey;
  if (openShortcut || slashShortcut) {
    event.preventDefault();
    void open();
    return;
  }

  if (!dialog || dialog.hidden) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter" && active >= 0) {
    const hit = hits[active];
    if (!hit) return;
    event.preventDefault();
    window.location.href = `${hit.url}${hit.anchor}`;
  } else if (event.key === "Tab") {
    // 只把焦点留在对话框里：输入框 → 结果 → 回到输入框。
    const focusables: HTMLElement[] = [];
    if (input) focusables.push(input);
    for (const link of list?.querySelectorAll<HTMLAnchorElement>("a") ?? []) {
      focusables.push(link);
    }
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

for (const trigger of document.querySelectorAll<HTMLElement>("[data-search-open]")) {
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    void open();
  });
}

for (const closer of document.querySelectorAll<HTMLElement>("[data-search-close]")) {
  closer.addEventListener("click", close);
}

input?.addEventListener("input", run);
document.addEventListener("keydown", onKeydown);

/** 供其它页面脚本调用（帮助中心目录的搜索框复用它）。 */
(window as unknown as { weaveSearch?: { open: (query?: string) => void } }).weaveSearch = {
  open: (query?: string) => void open(query),
};

const initialQuery = new URLSearchParams(window.location.search).get("q");
if (initialQuery) void open(initialQuery);
