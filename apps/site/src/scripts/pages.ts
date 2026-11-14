/**
 * 织序 WeaveOrder · 站内页面交互
 *
 * 帮助中心目录高亮、下载页系统识别、开通与演示表单（无后端时的邮件兜底）。
 * 与 main.ts 一样零依赖，禁用 JS 时内容与链接全部可用。
 */

import { trackFormSubmit } from "../lib/track";

/* --------------------------------------------------- 文档右侧目录高亮 */
const tocLinks = document.querySelectorAll<HTMLAnchorElement>(".docs-toc a[href^='#']");
if (tocLinks.length && "IntersectionObserver" in window) {
  const byId: Record<string, HTMLAnchorElement> = {};
  tocLinks.forEach((link) => {
    byId[link.getAttribute("href")?.slice(1) ?? ""] = link;
  });
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        tocLinks.forEach((link) => link.classList.remove("is-active"));
        const active = byId[entry.target.id];
        if (active) active.classList.add("is-active");
      });
    },
    { rootMargin: "-84px 0px -70% 0px" },
  );
  document.querySelectorAll(".docs-main h2[id]").forEach((heading) => observer.observe(heading));
}

/* ------------------------------------------------ 下载页：识别当前系统 */
const platformHint = document.getElementById("platformHint");
if (platformHint) {
  const ua = navigator.userAgent || "";
  let label = "网页版";
  if (/Windows/i.test(ua)) label = "Windows 桌面版";
  else if (/Macintosh|Mac OS X/i.test(ua)) label = "macOS 桌面版";
  else if (/iPhone|iPad|iPod/i.test(ua)) label = "iOS / 手机网页版";
  else if (/Android/i.test(ua)) label = "Android / 手机网页版";
  platformHint.innerHTML = `<b>你的系统</b>检测到你正在使用${label}，已为你标出推荐版本。`;
  const card = document.querySelector(`[data-platform="${label.split(" ")[0]?.toLowerCase()}"]`);
  card?.classList.add("is-recommended");
}

/* -------------------------------------------------- 表单：邮件兜底提交 */
document.querySelectorAll<HTMLFormElement>("form[data-mailform]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const to = form.getAttribute("data-mailform") ?? "";
    const subject = form.getAttribute("data-subject") || "织序 · 咨询";
    const lines: string[] = [];
    data.forEach((value, key) => {
      // 文件字段（FormDataEntryValue 可能是 File）不进邮件正文，只收文本。
      if (typeof value !== "string") return;
      const text = value.trim();
      if (!text) return;
      lines.push(`${key}：${text}`);
    });
    const href =
      `mailto:${to}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(lines.join("\n"))}`;
    const ok = form.querySelector(".form__ok");
    if (ok) {
      ok.textContent = `已整理好内容，正在打开你的邮件客户端。若没有弹出，直接写信到 ${to} 也行。`;
    }
    form.classList.add("is-sent");
    trackFormSubmit();
    window.location.href = href;
  });
});
