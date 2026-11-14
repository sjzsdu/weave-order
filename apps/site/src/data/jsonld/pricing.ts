// 由迁移脚本从旧站 pricing.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "织序 WeaveOrder",
    description:
      "纺织贸易的智能体原生业务操作系统：找样、报价、寄样跟进、订单、对账、打印单证由智能体完成，人只审批结果。",
    brand: {
      "@type": "Brand",
      name: "织序 WeaveOrder",
    },
    offers: [
      {
        "@type": "Offer",
        name: "基础版",
        price: "299",
        priceCurrency: "CNY",
        description: "每月，含 5 个账号与 20,000 credits，适合小团队起步",
        availability: "https://schema.org/InStock",
        url: "__SITE__/pricing.html",
      },
      {
        "@type": "Offer",
        name: "专业版",
        price: "899",
        priceCurrency: "CNY",
        description: "每月，含 20 个账号与 100,000 credits，六个智能体全部上线",
        availability: "https://schema.org/InStock",
        url: "__SITE__/pricing.html",
      },
    ],
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
        name: "价格",
        item: "__SITE__/pricing.html",
      },
    ],
  },
];
