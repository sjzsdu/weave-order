/* 织序 WeaveOrder · 站内搜索
   纯前端：构建期生成 assets/search-index.json，浏览器本地匹配，不联网、不埋点。
   第一版只做「找得到」：标题、章节标题、正文各有权重，中文按二元组命中。 */

(function () {
  "use strict";

  var script = document.currentScript;
  var root = new URL("../", script.src);
  var indexUrl = new URL("assets/search-index.json", root);
  var indexPromise = null;
  var dialog = null;
  var input = null;
  var list = null;
  var pages = [];
  var active = -1;
  var results = [];

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(indexUrl)
        .then(function (response) {
          if (!response.ok) throw new Error("index " + response.status);
          return response.json();
        })
        .then(function (data) {
          pages = data.pages || [];
          return pages;
        })
        .catch(function () {
          pages = [];
          return pages;
        });
    }
    return indexPromise;
  }

  function normalize(text) {
    return (text || "").toLowerCase().replace(/\s+/g, "");
  }

  /** 中文按二元组切；英文/数字按词切。 */
  function terms(query) {
    var q = normalize(query);
    if (!q) return [];
    if (/^[\x00-\x7f]+$/.test(q)) return q.split(/[^a-z0-9]+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < q.length - 1; i += 1) out.push(q.slice(i, i + 2));
    if (q.length === 1) out.push(q);
    return out;
  }

  function count(haystack, term) {
    if (!haystack) return 0;
    var n = 0;
    var at = 0;
    while ((at = haystack.indexOf(term, at)) !== -1) {
      n += 1;
      at += term.length;
      if (n >= 20) break;
    }
    return n;
  }

  function snippet(text, term) {
    if (!text) return "";
    var at = term ? text.indexOf(term) : -1;
    if (at < 0) return text.slice(0, 80);
    var start = Math.max(0, at - 28);
    return (start > 0 ? "…" : "") + text.slice(start, start + 90) + "…";
  }

  function search(query) {
    var parts = terms(query);
    if (!parts.length) return [];
    var hits = [];

    pages.forEach(function (page) {
      var title = normalize(page.title);
      var heading = normalize(page.heading);
      var description = normalize(page.description);
      var body = normalize(page.text);
      var score = 0;
      var firstTerm = parts[0];

      parts.forEach(function (term) {
        score += count(title, term) * 8;
        score += count(heading, term) * 5;
        score += count(description, term) * 3;
        score += Math.min(count(body, term), 6);
      });
      if (score === 0) return;

      var best = null;
      var bestScore = -1;
      (page.sections || []).forEach(function (section) {
        var s = 0;
        var h = normalize(section.heading);
        var t = normalize(section.text);
        parts.forEach(function (term) {
          s += count(h, term) * 6 + Math.min(count(t, term), 4);
        });
        if (s > bestScore) {
          bestScore = s;
          best = section;
        }
      });

      var text = best ? best.text : page.description || page.text;
      hits.push({
        url: page.url,
        title: page.title || page.heading || page.url,
        section: best ? best.heading : "",
        anchor: best && best.id ? "#" + best.id : "",
        score: score + Math.max(0, bestScore),
        snippet: snippet(text || "", firstTerm),
      });
    });

    return hits
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, 8);
  }

  function close() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    input = null;
    list = null;
    document.removeEventListener("keydown", onKey);
  }

  function render() {
    if (!list) return;
    list.innerHTML = "";
    if (!input.value.trim()) {
      var tip = document.createElement("p");
      tip.className = "search__tip";
      tip.textContent = "输入关键词：报价、导入、审批、打印、发票、邀请同事…";
      list.appendChild(tip);
      return;
    }
    if (!results.length) {
      var empty = document.createElement("p");
      empty.className = "search__tip";
      empty.textContent = "没有找到。换个说法试试，或写信到 hello@weaveorder.cn。";
      list.appendChild(empty);
      return;
    }
    results.forEach(function (hit, index) {
      var a = document.createElement("a");
      a.className = "search__hit" + (index === active ? " is-active" : "");
      a.href = new URL(hit.url, root).href + hit.anchor;
      var head = document.createElement("span");
      head.className = "search__hit-title";
      head.textContent = hit.title;
      a.appendChild(head);
      if (hit.section) {
        var crumb = document.createElement("span");
        crumb.className = "search__hit-section";
        crumb.textContent = hit.section;
        a.appendChild(crumb);
      }
      var snip = document.createElement("span");
      snip.className = "search__hit-snippet";
      snip.textContent = hit.snippet;
      a.appendChild(snip);
      a.addEventListener("mouseenter", function () {
        active = index;
        render();
      });
      list.appendChild(a);
    });
  }

  function run() {
    results = search(input.value);
    active = results.length ? 0 : -1;
    render();
  }

  function onKey(event) {
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      render();
    } else if (event.key === "Enter" && active >= 0 && results[active]) {
      event.preventDefault();
      window.location.href = new URL(results[active].url, root).href + results[active].anchor;
    }
  }

  function open() {
    if (dialog) return;
    dialog = document.createElement("div");
    dialog.className = "search";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "搜索站内内容");
    dialog.innerHTML =
      '<div class="search__panel">' +
      '<div class="search__bar"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5" stroke-linecap="round"/></svg>' +
      '<input class="search__input" type="search" placeholder="搜索：报价、导入、审批、打印…" aria-label="搜索站内内容" autocomplete="off" />' +
      '<kbd>Esc</kbd></div><div class="search__list" role="listbox"></div></div>';
    document.body.appendChild(dialog);
    input = dialog.querySelector(".search__input");
    list = dialog.querySelector(".search__list");
    input.addEventListener("input", run);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) close();
    });
    document.addEventListener("keydown", onKey);
    input.focus();
    loadIndex().then(run);
  }

  function mountButton() {
    var actions = document.querySelector(".nav__actions");
    if (!actions || actions.querySelector(".search__trigger")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "search__trigger";
    button.setAttribute("aria-label", "搜索站内内容");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5" stroke-linecap="round"/></svg><span>搜索</span>';
    button.addEventListener("click", open);
    actions.insertBefore(button, actions.firstChild);
  }

  function onShortcut(event) {
    var typing =
      event.target instanceof HTMLElement &&
      (event.target.tagName === "INPUT" ||
        event.target.tagName === "TEXTAREA" ||
        event.target.isContentEditable);
    if (typing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    } else if (event.key === "/" && !typing) {
      event.preventDefault();
      open();
    }
  }

  mountButton();
  document.addEventListener("keydown", onShortcut);

  // 分享/测试用：?q=报价 直接打开并出结果。
  var initial = new URLSearchParams(window.location.search).get("q");
  if (initial) {
    open();
    if (input) {
      input.value = initial;
      run();
    }
  }
})();
