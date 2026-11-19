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
    "pages/start/index",
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
    // 顺序与 src/routes.ts 的 ROUTES[].tab 一致：待办、客户、开报价、样品、我的。
    // 审批与相机不再占 tab，只保留路由（入口在待办 / 样品页里）。
    list: [
      {
        pagePath: "pages/today/index",
        text: "待办",
        iconPath: "assets/tab/today.png",
        selectedIconPath: "assets/tab/today-active.png",
      },
      {
        pagePath: "pages/customers/index",
        text: "客户",
        iconPath: "assets/tab/customers.png",
        selectedIconPath: "assets/tab/customers-active.png",
      },
      {
        pagePath: "pages/quote/index",
        text: "开报价",
        iconPath: "assets/tab/quote.png",
        selectedIconPath: "assets/tab/quote-active.png",
      },
      {
        pagePath: "pages/samples/index",
        text: "样品",
        iconPath: "assets/tab/samples.png",
        selectedIconPath: "assets/tab/samples-active.png",
      },
      {
        pagePath: "pages/more/index",
        text: "我的",
        iconPath: "assets/tab/more.png",
        selectedIconPath: "assets/tab/more-active.png",
      },
    ],
  },
});
