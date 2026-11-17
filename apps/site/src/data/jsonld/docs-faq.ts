// 由迁移脚本从旧站 docs/faq.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "织序 WeaveOrder 是什么？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "织序是纺织贸易的智能体原生业务操作系统。找样、报价、寄样跟进、订单跟踪、对账与打印单证由智能体完成，人只在审批卡上做决定。",
        },
      },
      {
        "@type": "Question",
        name: "织序和传统 ERP 软件有什么区别？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "传统 ERP 软件的前提是业务员操作软件、逐字段录入；织序的前提是 AI 员工是默认操作者，人只审批结果。功能表相近，但中间不再需要人搬数据。",
        },
      },
      {
        "@type": "Question",
        name: "怎么开通织序？要多久？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "在官网登记公司与联系人，工作日当天我们会发一条开通链接。点开链接、用统一账号登录，公司空间当场建好，你成为老板账号，3 天全功能试用，不绑卡、不收开通费。",
        },
      },
      {
        "@type": "Question",
        name: "智能体会不会自己把报价发给客户？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "不会。智能体只能产出草稿，必须由人点批准才生效。改幅超过 5% 或 1 万元自动升级主管，低于成本底线直接拦下。",
        },
      },
      {
        "@type": "Question",
        name: "数据安全吗？平台人员能看到我的客户吗？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "默认看不到。平台控制台只存账号、订阅与用量汇总，不存客户与报价明细。只有你报障并书面同意后，技术同事才能申请一次限时只读访问，全程留痕。",
        },
      },
      {
        "@type": "Question",
        name: "支持私有化部署吗？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "支持。定制版可以独立数据库、对接企业已有登录与组织架构，数据留在你指定的区域，按年度合同报价。",
        },
      },
      {
        "@type": "Question",
        name: "价格怎么算？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "按公司订阅：基础 299 元每月（含 5 个账号、20,000 credits），专业 899 元每月（含 20 个账号、100,000 credits），企业 2,999 元每月起。1 credit 约等于 1,000 个词的处理量，超额暂停并提醒，不自动扣费；年付为 10 个月价。",
        },
      },
      {
        "@type": "Question",
        name: "客户看报价需要注册吗？",
        acceptedAnswer: {
          "@type": "Answer",
          text: "不需要。报价链接打开即可查看，能留言、能接受，不需要下载 App。链接可设有效期与访问密码。",
        },
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
        name: "常见问题",
        item: "__SITE__/docs/faq.html",
      },
    ],
  },
];
