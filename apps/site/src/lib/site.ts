/**
 * 站点的基础配置与地址拼接。
 *
 * 唯一数据源是 src/site.config.json（与镜像里的 defaults.env 同源）：
 * 构建期用它拼 canonical / OG / sitemap，容器启动时再用环境变量覆盖页面里的地址
 * （见 docker/entrypoint.sh），所以换域名不用重新构建、重新发 tag。
 */
import config from "../site.config.json";

export const site = config.site;
export const app = config.app;
export const admin = config.admin;
export const sso = config.sso;
export const supportEmail = config.email;

/** 把站内路径拼成绝对地址：abs("/pricing.html") → "https://weaveorder.cn/pricing.html"。 */
export function abs(path: string): string {
  return new URL(path, `${site}/`).href;
}

/**
 * JSON-LD 里的地址占位符：数据文件写 __SITE__，渲染时换成实际站点地址。
 * 这样数据文件不必硬编码域名，改 site.config.json 即可。
 */
export const SITE_PLACEHOLDER = "__SITE__";

export function renderJsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll(SITE_PLACEHOLDER, site);
}
