// 由迁移脚本从旧站 index.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "__SITE__/#org",
        name: "织序 WeaveOrder",
        alternateName: "织序",
        url: "__SITE__/",
        logo: "__SITE__/assets/logo-mark.svg",
        email: "hello@weaveorder.cn",
        description: "纺织贸易的智能体原生业务操作系统。",
        sameAs: ["https://github.com/sjzsdu/weave-order"],
      },
      {
        "@type": "WebSite",
        "@id": "__SITE__/#website",
        url: "__SITE__/",
        name: "织序 WeaveOrder",
        inLanguage: "zh-CN",
        publisher: {
          "@id": "__SITE__/#org",
        },
      },
      {
        "@type": "SoftwareApplication",
        name: "织序 WeaveOrder",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web, Windows, macOS, iOS, Android",
        url: "__SITE__/",
        installUrl: "https://app.wnbgj.com",
        description:
          "纺织贸易的智能体原生业务操作系统：智能体完成找样、报价、寄样跟进、订单跟踪与对账，人类只负责审批结果。",
        offers: {
          "@type": "Offer",
          price: "299",
          priceCurrency: "CNY",
          description: "基础版每月，含 5 个账号与 20,000 credits，3 天免费试用",
        },
        publisher: {
          "@id": "__SITE__/#org",
        },
      },
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "智能体会不会乱改价格、乱发消息？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "不会。智能体只能产出草稿，必须由人批准才生效。改幅超过 5% 或 1 万元自动升级主管，低于成本底线直接拦下；它没有直接写业务数据的权限。",
        },
      },
      {
        "@type": "Question",
        name: "我们现在的 Excel 客户表和样品表能导进来吗？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "能。Excel 或 CSV 整批导入，逐行校验；任何一行不合格整批都不收，并指出哪一行哪一列有问题。",
        },
      },
      {
        "@type": "Question",
        name: "业务员不愿意用怎么办？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "让他们少干活而不是多填表：微信原话直接转发进来派活，草稿在手机上批，客户数据默认只有本人可见。",
        },
      },
      {
        "@type": "Question",
        name: "数据安全吗？能不能私有化？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "默认每家公司的数据互相看不见，由数据库本身强制隔开；合同可升级到独立库或独立数据库。审计只追加不可改写，平台侧默认看不到你的业务数据。",
        },
      },
      {
        "@type": "Question",
        name: "和传统 ERP 软件是什么关系？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "不是替代它记录的生意，是替代中间搬数据的人。传统 ERP 软件把能力组织成菜单，织序把同样的能力组织成智能体可调用的工具加人能审批的草稿。",
        },
      },
      {
        "@type": "Question",
        name: "多久能上线？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "第一天导入客户与样品，第一周挑一个业务员试点报价链路，第二周看数据，通常两到三周可以全团队切换。",
        },
      },
    ],
  },
];
