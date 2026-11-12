export default defineAppConfig({
  pages: [
    "pages/today/index",
    "pages/approvals/index",
    "pages/camera/index",
    "pages/customers/index",
    "pages/more/index",
  ],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#f7f7f5",
    navigationBarTitleText: "织序",
    navigationBarTextStyle: "black",
  },
  tabBar: {
    color: "#5f646d",
    selectedColor: "#1f6f5c",
    backgroundColor: "#ffffff",
    borderStyle: "white",
    list: [
      { pagePath: "pages/today/index", text: "今日" },
      { pagePath: "pages/approvals/index", text: "审批" },
      { pagePath: "pages/camera/index", text: "相机" },
      { pagePath: "pages/customers/index", text: "客户" },
      { pagePath: "pages/more/index", text: "更多" },
    ],
  },
});
