// 由迁移脚本从旧站 docs/quickstart.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "5 分钟上手织序 WeaveOrder",
    description: "登录、导入客户与样品、派第一件活、审一张报价草稿、邀请同事。",
    totalTime: "PT5M",
    step: [
      {
        "@type": "HowToStep",
        position: 1,
        name: "登录工作台",
        text: "打开 weave.wnbgj.com，用公司统一账号登录，落在「工作台」。",
        url: "__SITE__/docs/quickstart.html#login",
      },
      {
        "@type": "HowToStep",
        position: 2,
        name: "导入客户与样品",
        text: "把现有 Excel 拖进导入页，逐行检查后整批入库。",
        url: "__SITE__/docs/quickstart.html#import",
      },
      {
        "@type": "HowToStep",
        position: 3,
        name: "派第一件活",
        text: "按 ⌘K 输入客户原话，例如「青禾要 32S 精梳棉氨纶汗布 3.2 吨，问上次的价能不能再让 1%」。",
        url: "__SITE__/docs/quickstart.html#first-job",
      },
      {
        "@type": "HowToStep",
        position: 4,
        name: "审一张草稿",
        text: "在审批窗口看金额、改动和出处，批准、改一处或驳回。",
        url: "__SITE__/docs/quickstart.html#approve",
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
        name: "帮助中心",
        item: "__SITE__/docs/",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "5 分钟上手",
        item: "__SITE__/docs/quickstart.html",
      },
    ],
  },
];
