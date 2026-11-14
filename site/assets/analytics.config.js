/* 织序 WeaveOrder · 访问统计配置
 *
 * 由 site/tools/configure.mjs 从 site/site.config.json 生成，不要手改。
 * 改法：容器启动时给 WEAVE_ANALYTICS_PROVIDER / DOMAIN / HOST / KEY，
 * 或本地跑 node site/tools/configure.mjs --analytics-provider ...
 *
 * provider：plausible | posthog | none。none 时 assets/analytics.js 完全静默，
 * 不注入第三方脚本、不发任何请求。也可以在页面里更早地写
 * window.WEAVE_ANALYTICS 覆盖这里。
 * 事件字典见 site/README.md「访问统计」。
 */

window.WEAVE_ANALYTICS = {
  provider: "none",
  domain: "",
  host: "",
  key: ""
};
