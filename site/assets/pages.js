/* 织序 WeaveOrder · 站内页面交互
   帮助中心目录高亮、下载页系统识别、开通与演示表单（无后端时的邮件兜底）。
   与 main.js 一样零依赖，禁用 JS 时内容与链接全部可用。 */

(function () {
  "use strict";

  /* --------------------------------------------------- 文档右侧目录高亮 */
  var tocLinks = document.querySelectorAll(".docs-toc a[href^='#']");
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    Array.prototype.forEach.call(tocLinks, function (link) {
      byId[link.getAttribute("href").slice(1)] = link;
    });
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          Array.prototype.forEach.call(tocLinks, function (link) {
            link.classList.remove("is-active");
          });
          var active = byId[entry.target.id];
          if (active) active.classList.add("is-active");
        });
      },
      { rootMargin: "-84px 0px -70% 0px" }
    );
    Array.prototype.forEach.call(document.querySelectorAll(".docs-main h2[id]"), function (heading) {
      observer.observe(heading);
    });
  }

  /* ------------------------------------------------ 下载页：识别当前系统 */
  var platformHint = document.getElementById("platformHint");
  if (platformHint) {
    var ua = navigator.userAgent || "";
    var label = "网页版";
    if (/Windows/i.test(ua)) label = "Windows 桌面版";
    else if (/Macintosh|Mac OS X/i.test(ua)) label = "macOS 桌面版";
    else if (/iPhone|iPad|iPod/i.test(ua)) label = "iOS / 手机网页版";
    else if (/Android/i.test(ua)) label = "Android / 手机网页版";
    platformHint.innerHTML = "<b>你的系统</b>检测到你正在使用" + label + "，已为你标出推荐版本。";
    var card = document.querySelector('[data-platform="' + label.split(" ")[0].toLowerCase() + '"]');
    if (card) card.classList.add("is-recommended");
  }

  /* -------------------------------------------------- 表单：邮件兜底提交 */
  var forms = document.querySelectorAll("form[data-mailform]");
  Array.prototype.forEach.call(forms, function (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var data = new FormData(form);
      var to = form.getAttribute("data-mailform");
      var subject = form.getAttribute("data-subject") || "织序 · 咨询";
      var lines = [];
      data.forEach(function (value, key) {
        if (!String(value).trim()) return;
        lines.push(key + "：" + value);
      });
      var href =
        "mailto:" +
        to +
        "?subject=" +
        encodeURIComponent(subject) +
        "&body=" +
        encodeURIComponent(lines.join("\n"));
      var ok = form.querySelector(".form__ok");
      if (ok) {
        ok.textContent =
          "已整理好内容，正在打开你的邮件客户端。若没有弹出，直接写信到 " + to + " 也行。";
      }
      form.classList.add("is-sent");
      window.location.href = href;
    });
  });
})();
