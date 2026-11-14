/**
 * 织序 WeaveOrder · 官网交互
 *
 * 只做四件事：吸顶状态、移动端菜单、滚动入场、审批卡演示。
 * 没有依赖；禁用 JS 时内容与链接全部可用。埋点统一走 lib/track.ts，
 * 这里只在表单真的交给邮件客户端时喊一声 signup_form_submit。
 */

import { trackFormSubmit } from "../lib/track";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------- header */
const header = document.getElementById("siteHeader");
const toggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");

function onScroll(): void {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 8);
}
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

if (toggle && header) {
  toggle.addEventListener("click", () => {
    const open = header.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
  });
  if (navLinks) {
    navLinks.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("a")) {
        header.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }
}

/* ---------------------------------------------------------------- reveal */
const revealItems = document.querySelectorAll(".reveal");
if (!("IntersectionObserver" in window) || reduceMotion) {
  revealItems.forEach((el) => el.classList.add("is-in"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        revealObserver.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
  );
  revealItems.forEach((el) => revealObserver.observe(el));
  // 兜底：观察器异常或快速跳转时，1 秒后强制显示，内容不会永远停在透明状态
  window.setTimeout(() => {
    revealItems.forEach((el) => el.classList.add("is-in"));
  }, 1000);
}

/* --------------------------------------------------------- approval demo */
const card = document.getElementById("approvalCard");
const chip = document.getElementById("approvalChip");
const approveBtn = document.querySelector<HTMLButtonElement>("#approveBtn");
const note = document.getElementById("approvalNote");
const hint = document.querySelector(".approval__hint");
const editBtn = document.getElementById("editBtn");
let approved = false;

const SEALED_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
  '<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z" stroke-linejoin="round"/>' +
  '<path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function sealApproval(): void {
  if (!card || approved) return;
  approved = true;
  card.classList.add("is-confirmed");
  if (chip) {
    chip.className = "chip chip--ok";
    chip.textContent = "已批准 · 已发送";
  }
  if (approveBtn) {
    approveBtn.textContent = "已发送给客户";
    approveBtn.disabled = true;
    approveBtn.style.opacity = "0.55";
    approveBtn.style.cursor = "default";
  }
  if (note) {
    note.innerHTML = `${SEALED_ICON}已生成客户报价链接 weave.order/s/9f3c · 审计已留痕`;
  }
  if (hint) {
    hint.textContent = "这一步之后，智能体接着跟单、提醒、对账。你不需要再点任何东西。";
  }
}

approveBtn?.addEventListener("click", sealApproval);

editBtn?.addEventListener("click", () => {
  if (approved) return;
  editBtn.textContent = "−1% 并重算";
  editBtn.title = "演示：按客户要求让 1%，内核重算金额";
  const amount = card?.querySelector(".money");
  const ins = card?.querySelector(".diff ins");
  if (!amount || !ins) return;
  const fixed = document.createElement("span");
  fixed.className = "chip chip--warn";
  fixed.textContent = "改幅 −1.0% · 已重算";
  ins.textContent = "¥23.56";
  amount.textContent = "¥75,392.00";
  const row = ins.closest(".approval__row");
  if (row && !row.querySelector(".chip--warn:not([data-static])")) {
    const old = row.querySelector(".chip--warn");
    if (old) old.replaceWith(fixed);
  }
  if (note) {
    note.innerHTML = `${SEALED_ICON}金额已重新计算，仍在你 5% 的改价权限内。`;
  }
});

/* ------------------------------------------------------------- form */
const form = document.getElementById("demoForm");
if (form) {
  form.addEventListener("submit", (event) => {
    const required = form.querySelectorAll<HTMLInputElement>("[required]");
    let valid = true;
    required.forEach((input) => {
      if (!input.value.trim()) {
        valid = false;
        input.style.borderColor = "#C0492F";
      } else {
        input.style.borderColor = "";
      }
    });
    if (!valid) {
      event.preventDefault();
      const first = form.querySelector<HTMLInputElement>("[required]");
      first?.focus();
      return;
    }
    form.classList.add("is-sent");
    // 到这一步才算「交给邮件客户端」，不读表单内容。
    trackFormSubmit();
  });
}
