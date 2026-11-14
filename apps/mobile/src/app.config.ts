export default defineAppConfig({
  pages: [
    "pages/today/index",
    "pages/approvals/index",
    "pages/camera/index",
    "pages/customers/index",
    "pages/samples/index",
    "pages/more/index",
    "pages/quote/index",
    "pages/customer/index",
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
    // iconPath 相对 sourceRoot(src/) 解析；H5 由 taro-loader 打成 asset，
    // 小程序由 MiniPlugin 原样拷到包根。两套图标由
    // scripts/build-tabbar-icons.mjs 从 assets/tabbar/*.svg 生成，别手改 PNG。
    list: [
      {
        pagePath: "pages/today/index",
        text: "今日",
        iconPath: "assets/tab/today.png",
        selectedIconPath: "assets/tab/today-active.png",
      },
      {
        pagePath: "pages/approvals/index",
        text: "审批",
        iconPath: "assets/tab/approvals.png",
        selectedIconPath: "assets/tab/approvals-active.png",
      },
      {
        pagePath: "pages/camera/index",
        text: "相机",
        iconPath: "assets/tab/camera.png",
        selectedIconPath: "assets/tab/camera-active.png",
      },
      {
        pagePath: "pages/customers/index",
        text: "客户",
        iconPath: "assets/tab/customers.png",
        selectedIconPath: "assets/tab/customers-active.png",
      },
      {
        pagePath: "pages/more/index",
        text: "更多",
        iconPath: "assets/tab/more.png",
        selectedIconPath: "assets/tab/more-active.png",
      },
    ],
  },
});
