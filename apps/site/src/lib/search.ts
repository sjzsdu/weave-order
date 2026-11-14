/**
 * 站内搜索的纯函数实现（不碰 DOM，方便单测）。
 *
 * 官网是纯静态托管，没有后端：索引在构建期生成（scripts/build-search-index.mjs），
 * 浏览器把它整个下载下来在本地匹配。中文按二元组切词，英文按词切。
 *
 * 打分思路：标题 > 章节标题 > 描述 > 正文；每条结果再取命中最强的章节，
 * 直接给出锚点，点进去就落在那一段，而不是页面顶部。
 */

export interface SearchSection {
  id: string | null;
  heading: string;
  text: string;
}

export interface SearchPage {
  url: string;
  title: string;
  heading: string;
  description: string;
  text: string;
  sections: SearchSection[];
}

export interface SearchHit {
  url: string;
  title: string;
  section: string;
  anchor: string;
  snippet: string;
  score: number;
}

export const MAX_RESULTS = 8;

function normalize(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, "");
}

/** 中文按二元组切，英文/数字按词切。 */
export function terms(query: string): string[] {
  const q = normalize(query);
  if (!q) return [];
  if (/^[\x20-\x7e]+$/.test(q)) return q.split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < q.length - 1; i += 1) out.push(q.slice(i, i + 2));
  if (q.length === 1) out.push(q);
  return out;
}

function count(haystack: string, term: string): number {
  if (!haystack) return 0;
  let n = 0;
  let at = 0;
  while ((at = haystack.indexOf(term, at)) !== -1) {
    n += 1;
    at += term.length;
    if (n >= 20) break;
  }
  return n;
}

function snippet(text: string, term: string): string {
  if (!text) return "";
  const at = term ? text.indexOf(term) : -1;
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 28);
  return (start > 0 ? "…" : "") + text.slice(start, start + 90) + "…";
}

export function searchPages(pages: SearchPage[], query: string, limit = MAX_RESULTS): SearchHit[] {
  const parts = terms(query);
  if (!parts.length) return [];
  const found: SearchHit[] = [];

  for (const page of pages) {
    const title = normalize(page.title);
    const heading = normalize(page.heading);
    const description = normalize(page.description);
    const body = normalize(page.text);
    let score = 0;

    for (const term of parts) {
      score += count(title, term) * 8;
      score += count(heading, term) * 5;
      score += count(description, term) * 3;
      score += Math.min(count(body, term), 6);
    }
    if (score === 0) continue;

    let best: SearchSection | null = null;
    let bestScore = -1;
    for (const section of page.sections ?? []) {
      let sectionScore = 0;
      const sectionHeading = normalize(section.heading);
      const sectionText = normalize(section.text);
      for (const term of parts) {
        sectionScore += count(sectionHeading, term) * 6 + Math.min(count(sectionText, term), 4);
      }
      if (sectionScore > bestScore) {
        bestScore = sectionScore;
        best = section;
      }
    }

    const text = best ? best.text : page.description || page.text;
    found.push({
      url: page.url,
      title: page.title || page.heading || page.url,
      section: best ? best.heading : "",
      anchor: best && best.id ? `#${best.id}` : "",
      snippet: snippet(text || "", parts[0] ?? ""),
      score: score + Math.max(0, bestScore),
    });
  }

  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}
