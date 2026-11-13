/* 织序 WeaveOrder · 官网交互
   只做四件事：吸顶状态、移动端菜单、滚动入场、审批卡演示。
   没有依赖，没有埋点。 */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- header */
  var header = document.getElementById("siteHeader");
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");

  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if (toggle && header) {
    toggle.addEventListener("click", function () {
      var open = header.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
    });
    if (links) {
      links.addEventListener("click", function (event) {
        if (event.target.closest("a")) {
          header.classList.remove("is-open");
          toggle.setAttribute("aria-expanded", "false");
        }
      });
    }
  }

  /* ---------------------------------------------------------------- reveal */
  var revealItems = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || reduceMotion) {
    Array.prototype.forEach.call(revealItems, function (el) {
      el.classList.add("is-in");
    });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.06 }
    );
    Array.prototype.forEach.call(revealItems, function (el) {
      revealObserver.observe(el);
    });
    // 兜底：观察器异常或快速跳转时，1 秒后强制显示，内容不会永远停在透明状态
    window.setTimeout(function () {
      Array.prototype.forEach.call(revealItems, function (el) {
        el.classList.add("is-in");
      });
    }, 1000);
  }

  /* --------------------------------------------------------- approval demo */
  var card = document.getElementById("approvalCard");
  var chip = document.getElementById("approvalChip");
  var approveBtn = document.getElementById("approveBtn");
  var note = document.getElementById("approvalNote");
  var hint = document.querySelector(".approval__hint");
  var editBtn = document.getElementById("editBtn");
  var approved = false;

  function sealApproval() {
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
      note.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
        '<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z" stroke-linejoin="round"/>' +
        '<path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        "已生成客户报价链接 weave.order/s/9f3c · 审计已留痕";
    }
    if (hint) {
      hint.textContent = "这一步之后，智能体接着跟单、提醒、对账。你不需要再点任何东西。";
    }
  }

  if (approveBtn) approveBtn.addEventListener("click", sealApproval);

  if (editBtn) {
    editBtn.addEventListener("click", function () {
      if (approved) return;
      editBtn.textContent = "−1% 并重算";
      editBtn.title = "演示：按客户要求让 1%，内核重算金额";
      var amount = card && card.querySelector(".money");
      var ins = card && card.querySelector(".diff ins");
      if (!amount || !ins) return;
      var fixed = document.createElement("span");
      fixed.className = "chip chip--warn";
      fixed.textContent = "改幅 −1.0% · 已重算";
      ins.textContent = "¥23.56";
      amount.textContent = "¥75,392.00";
      var row = ins.closest(".approval__row");
      if (row && !row.querySelector(".chip--warn:not([data-static])")) {
        var old = row.querySelector(".chip--warn");
        if (old) old.replaceWith(fixed);
      }
      if (note) {
        note.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
          '<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z" stroke-linejoin="round"/>' +
          '<path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          "金额由内核重算，不是前端改数字。仍在你 5% 的改价权限内。";
      }
    });
  }

  /* ------------------------------------------------------------- form */
  var form = document.getElementById("demoForm");
  if (form) {
    form.addEventListener("submit", function (event) {
      var required = form.querySelectorAll("[required]");
      var valid = true;
      Array.prototype.forEach.call(required, function (input) {
        if (!input.value.trim()) {
          valid = false;
          input.style.borderColor = "#C0492F";
        } else {
          input.style.borderColor = "";
        }
      });
      if (!valid) {
        event.preventDefault();
        var first = form.querySelector("[required]");
        if (first) first.focus();
        return;
      }
      form.classList.add("is-sent");
    });
  }
})();
