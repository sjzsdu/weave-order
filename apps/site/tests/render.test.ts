/**
 * 部署期渲染的用例。
 *
 * 域名、备案号、搜索验证 meta、统计配置都不在构建期写死，而是容器启动时由
 * docker/entrypoint.sh 按环境变量渲染。这条链路是「换域名不重新构建」的全部依据，
 * 坏了不会有页面报错，只会让 canonical / sitemap 指向旧域名——所以直接跑脚本验证：
 * 渲染后的产物里，新域名该在的地方都在，旧域名一处不剩，重启能回退。
 *
 * `pnpm --filter @weave-order/site test` 会先 build 再跑这里。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const siteDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(siteDir, "dist");
const configPath = join(siteDir, "src/site.config.json");
const prepareScript = join(siteDir, "scripts/prepare-config.mjs");
const entrypoint = join(siteDir, "docker/entrypoint.sh");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DEFAULT_SITE = "https://weaveorder.cn";

/**
 * 跑一遍「prepare-config → entrypoint」，返回渲染后的目录。
 * 每次都从 dist 复制一份新产物，和容器启动时重铺原始产物的行为一致。
 */
function render(env: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), "weave-site-render-"));
  tempDirs.push(work);

  const renderDir = join(work, "render");
  const defaultsFile = join(work, "defaults.env");
  cpSync(distDir, renderDir, { recursive: true });

  execFileSync(process.execPath, [prepareScript, configPath, defaultsFile], { stdio: "pipe" });
  execFileSync("sh", [entrypoint], {
    stdio: "pipe",
    env: {
      ...process.env,
      SITE_DIR: renderDir,
      PRISTINE_DIR: distDir,
      DEFAULTS_FILE: defaultsFile,
      ...env,
    },
  });

  return {
    dir: renderDir,
    read: (file: string) => readFileSync(join(renderDir, file), "utf8"),
  };
}

describe("部署期域名渲染", () => {
  it("默认渲染：沿用 site.config.json，不留运行期占位符", () => {
    const { read } = render();
    const home = read("index.html");

    expect(home).toContain(`<link rel="canonical" href="${DEFAULT_SITE}/"`);
    expect(home).not.toContain("__WEAVE_");
    expect(read("sitemap.xml")).toContain(`<loc>${DEFAULT_SITE}/pricing.html</loc>`);
    expect(read("robots.txt")).toContain(`Sitemap: ${DEFAULT_SITE}/sitemap.xml`);
    // 没有配置验证码时 content 为空，爬虫会忽略；关键是占位符不能漏出去。
    expect(home).toContain('<meta name="google-site-verification" content="">');
    expect(home).toContain('<meta name="msvalidate.01" content="">');
    expect(home).toContain('<meta name="baidu-site-verification" content="">');
  });

  it("换域名：canonical / OG / sitemap / robots / llms / 统计全部跟着走", () => {
    const site = "https://www.weave-order.example";
    const { read } = render({
      WEAVE_SITE_URL: site,
      WEAVE_SUPPORT_EMAIL: "hi@weave-order.example",
      WEAVE_ANALYTICS_PROVIDER: "plausible",
      WEAVE_ANALYTICS_DOMAIN: "weave-order.example",
    });

    const home = read("index.html");
    expect(home).toContain(`<link rel="canonical" href="${site}/"`);
    expect(home).toContain(`property="og:image" content="${site}/assets/og-cover.png"`);
    expect(home).toContain(`"url":"${site}/"`);
    expect(home).toContain('"provider":"plausible"');
    expect(home).toContain('"domain":"weave-order.example"');
    expect(home).toContain("hi@weave-order.example");

    const sitemap = read("sitemap.xml");
    expect(sitemap).toContain(`<loc>${site}/</loc>`);
    expect(sitemap).not.toContain(DEFAULT_SITE);

    expect(read("robots.txt")).toContain(`Sitemap: ${site}/sitemap.xml`);
    expect(read("llms.txt")).toContain(`${site}/docs/`);
    // 旧域名一处不剩（页面、sitemap、llms、robots 都算）。
    for (const file of ["index.html", "pricing.html", "sitemap.xml", "robots.txt", "llms.txt"]) {
      expect(read(file), `${file} 仍含旧域名`).not.toContain("weaveorder.cn");
    }
    expect(home).not.toContain("__WEAVE_");
  });

  it("备案号与搜索验证：配置了才输出，未配置不露出占位符", () => {
    const { read } = render({
      WEAVE_ICP_LICENSE: "京ICP备2026000001号-1",
      WEAVE_PSB_LICENSE: "京公网安备 11010502000001号",
      WEAVE_VERIFY_GOOGLE: "google-token_123",
      WEAVE_VERIFY_BING: "bing-token-456",
      WEAVE_VERIFY_BAIDU: "baidu-token.789",
    });
    const home = read("index.html");

    expect(home).toContain("京ICP备2026000001号-1");
    expect(home).toContain("京公网安备 11010502000001号");
    // 配置后要真的可见（去掉 hidden），否则等于没展示。
    expect(home).toMatch(/<a data-weave-icp /);
    expect(home).toMatch(/<span data-weave-psb>/);
    expect(home).toContain('<meta name="google-site-verification" content="google-token_123"');
    expect(home).toContain('<meta name="msvalidate.01" content="bing-token-456"');
    expect(home).toContain('<meta name="baidu-site-verification" content="baidu-token.789"');
  });

  it("非法验证码不写坏页面，重启后能回退到默认域名", () => {
    const broken = render({ WEAVE_VERIFY_GOOGLE: 'bad"' });
    expect(broken.read("index.html")).toContain(
      '<meta name="google-site-verification" content="">',
    );

    const first = render({ WEAVE_SITE_URL: "https://www.weave-order.example" });
    expect(first.read("index.html")).toContain("https://www.weave-order.example/");

    // 第二次用默认值重新铺产物：上一轮的新域名不能残留。
    const second = render();
    const home = second.read("index.html");
    expect(home).toContain(`<link rel="canonical" href="${DEFAULT_SITE}/"`);
    expect(home).not.toContain("weave-order.example");
  });
});
