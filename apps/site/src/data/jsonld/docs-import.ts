// 由迁移脚本从旧站 docs/import.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default {
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
    {
      "@type": "ListItem",
      position: 3,
      name: "导入客户与样品",
      item: "__SITE__/docs/import.html",
    },
  ],
};
