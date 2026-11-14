/**
 * 指南页的结构化数据。
 *
 * 为什么不在每页手写 JSON-LD：四个指南页的 BreadcrumbList、FAQPage、HowTo 形状完全
 * 一样，只有文字不同。手写四份的结果是「某天改了 FAQ 措辞，结构化数据里的答案还是
 * 旧的」——搜索会把这种不一致当成作弊信号。所以 FAQ 与 HowTo 只有一份来源：MDX 的
 * frontmatter，页面上的可见问答块和这里的 JSON-LD 都从它渲染。
 *
 * 地址里的 __SITE__ 由 renderJsonLd 在渲染时替换成站点地址（见 lib/site.ts），
 * 部署期再按环境变量改写域名。
 */
import { SITE_PLACEHOLDER } from "./site";

export interface GuideFaq {
  q: string;
  a: string;
}

export interface GuideHowTo {
  name: string;
  description: string;
  totalTime: string;
  steps: { name: string; text: string }[];
}

interface GuideJsonLdInput {
  /** 面包屑末项的长标题。 */
  crumb: string;
  /** 站内文件名，如 "sample-follow-up.html"。 */
  file: string;
  faq: GuideFaq[];
  howTo?: GuideHowTo;
}

const SITE = SITE_PLACEHOLDER;

/** 首页 → 帮助中心 → 当前指南。与页面上面包屑的顺序一一对应。 */
function breadcrumbLd(crumb: string, file: string): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "首页", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "帮助中心", item: `${SITE}/docs/` },
      { "@type": "ListItem", position: 3, name: crumb, item: `${SITE}/guides/${file}` },
    ],
  };
}

function faqLd(faq: GuideFaq[]): Record<string, unknown> {
  return {
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

function howToLd(howTo: GuideHowTo): Record<string, unknown> {
  return {
    "@type": "HowTo",
    name: howTo.name,
    description: howTo.description,
    totalTime: howTo.totalTime,
    step: howTo.steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: step.text,
    })),
  };
}

/**
 * 一页的全部结构化数据：BreadcrumbList 必发；FAQPage 有问答才发；
 * HowTo 只有流程类指南（寄样、对账）才有。
 *
 * 多个实体放进同一个 @graph（与首页的写法一致）：一个 <script> 就够了，
 * 不用为了「几个类型」拼几段 JSON。
 */
export function guideJsonLd({ crumb, file, faq, howTo }: GuideJsonLdInput): unknown {
  const graph: Record<string, unknown>[] = [breadcrumbLd(crumb, file)];
  if (faq.length > 0) graph.push(faqLd(faq));
  if (howTo) graph.push(howToLd(howTo));
  return { "@context": "https://schema.org", "@graph": graph };
}
