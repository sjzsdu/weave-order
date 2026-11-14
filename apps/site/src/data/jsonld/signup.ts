// 由迁移脚本从旧站 signup.html 提取。地址里的 __SITE__ 在渲染时替换为站点地址。
export default [
  {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "如何开通织序 WeaveOrder",
    description:
      "登记公司与联系人，工作日当天收到开通链接，点开登录即建好公司空间。3 天全功能试用。",
    totalTime: "PT10M",
    step: [
      {
        "@type": "HowToStep",
        position: 1,
        name: "登记公司与联系人",
        text: "填写公司名称、你的称呼、手机或微信、团队人数。1 分钟。",
      },
      {
        "@type": "HowToStep",
        position: 2,
        name: "我们开通企业空间",
        text: "工作日内当天配好套餐与 3 天试用期，把一条开通链接发到你的微信或邮箱。",
      },
      {
        "@type": "HowToStep",
        position: 3,
        name: "导入数据，跑第一单",
        text: "用邮件里的链接登录，导入现有的客户与样品 Excel，把客户刚发来的一句话贴进去，审核第一张报价草稿。",
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
        name: "免费试用",
        item: "__SITE__/signup.html",
      },
    ],
  },
];
