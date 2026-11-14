// 由迁移脚本从旧站 download.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "织序 WeaveOrder",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, Windows, macOS, iOS, Android",
    url: "__SITE__/download.html",
    installUrl: "https://weave.wnbgj.com",
    description:
      "纺织贸易的智能体原生业务操作系统：找样、报价、寄样跟进、订单、对账、打印单证由智能体完成，人只审批结果。",
    publisher: {
      "@type": "Organization",
      name: "织序 WeaveOrder",
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
        name: "下载",
        item: "__SITE__/download.html",
      },
    ],
  },
];
