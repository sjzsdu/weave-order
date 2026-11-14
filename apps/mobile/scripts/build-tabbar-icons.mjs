/**
 * 生成移动端 tabBar 图标（普通态 / 选中态两套颜色）。
 *
 * 起因：app.config.ts 里 tabBar 各项没写 iconPath，Taro H5 的 taro-tabbar
 * 组件会无条件渲染 <img class="weui-tabbar__icon">，src 为空就是一个 27x27 的
 * 空框（小程序端则是纯文字），所以移动端底部五个 Tab 一个图标都没有。
 *
 * 用法：node scripts/build-tabbar-icons.mjs
 * 产物：src/assets/tab/<name>.png 与 <name>-active.png（81x81，透明底）
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SVG_DIR = join(ROOT, "assets", "tabbar");
const OUT_DIR = join(ROOT, "src", "assets", "tab");

// 与 src/app.scss 的 $muted / $accent 一致；app.config.ts 的
// tabBar.color / selectedColor 也要对得上。
const NORMAL = "#5f646d";
const ACTIVE = "#1f6f5c";

// H5 端 weui-tabbar__icon 是 27x27 CSS px；小程序端 tabBar 图标建议 81x81。
// 81 覆盖到 3x 屏，H5 与小程序共用同一份。
const SIZE = 81;

/** 把母版里的 currentColor 换成实色，sharp 的 librsvg 不吃 currentColor。 */
function paint(svg, color) {
  return svg.replace(/currentColor/g, color);
}

async function render(svg, color, out) {
  const buf = await sharp(Buffer.from(paint(svg, color)), { density: 384 })
    .resize(SIZE, SIZE, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(out, buf);
}

async function main() {
  const files = (await readdir(SVG_DIR)).filter((name) => name.endsWith(".svg")).sort();
  if (!files.length) throw new Error(`${SVG_DIR} 下没有 .svg 母版`);

  await mkdir(OUT_DIR, { recursive: true });

  for (const file of files) {
    const name = file.replace(/\.svg$/, "");
    const svg = await readFile(join(SVG_DIR, file), "utf8");
    await render(svg, NORMAL, join(OUT_DIR, `${name}.png`));
    await render(svg, ACTIVE, join(OUT_DIR, `${name}-active.png`));
    console.log("tabbar icon:", name);
  }

  console.log(`done -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
