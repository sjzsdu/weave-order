// 由迁移脚本从旧站 docs/index.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "织序帮助中心",
    description: "织序 WeaveOrder 的帮助文档：上手、导入、审批、报价、打印、智能体接入与数据安全。",
    inLanguage: "zh-CN",
    isPartOf: {
      "@type": "WebSite",
      name: "织序 WeaveOrder",
      url: "__SITE__/",
    },
  },
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "首页",
        item: "__SITE__/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "帮助中心",
        item: "__SITE__/docs/",
      },
    ],
  },
];
