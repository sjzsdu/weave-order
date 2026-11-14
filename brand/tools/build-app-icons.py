"""按端生成应用图标：Web / 总管理端 / 报价页 / 移动端 PWA / 打印代理（Tauri）。

用法：python3 brand/tools/build-app-icons.py
依赖：Chrome（无头渲染 SVG）、Pillow（ICO 合成）。
产物：
  brand/icons/                      各尺寸母版（透明底）
  apps/{web,admin,quote}/app/       icon.svg / apple-icon.png / favicon.ico
  apps/mobile/src/pwa/icons/        PWA 图标、maskable 与 apple-touch-icon
  apps/print-agent/src-tauri/icons/ Tauri 桌面图标（png / ico / icns）

Logo 改动后先跑 build-logo.py，再跑本脚本；不要再手工导出图标。
"""
import glob
import os
import shutil
import struct
import subprocess
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRAND = os.path.join(ROOT, "brand")
ICONS = os.path.join(BRAND, "icons")

SIZES = [16, 32, 48, 64, 128, 152, 180, 192, 256, 512, 1024]

INK = "#14202B"

CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH", ""),
    *sorted(
        glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome")),
        reverse=True,
    ),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome() -> str:
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    raise SystemExit("找不到 Chrome，请设置 CHROME_PATH 后重试")


def render(html: str, size: int, out: str) -> None:
    chrome = find_chrome()
    with tempfile.NamedTemporaryFile(
        "w", suffix=".html", dir=BRAND, delete=False, encoding="utf-8"
    ) as f:
        f.write(html)
        page = f.name
    try:
        subprocess.run(
            [
                chrome,
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                "--default-background-color=00000000",
                f"--screenshot={out}",
                f"--window-size={size},{size}",
                f"file://{page}",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    finally:
        os.unlink(page)


def page_for(mark_ratio: float, background: str | None, mark: str = "logo-mark.svg") -> str:
    """mark_ratio 为标记边长占画布的比例；background=None 表示透明底。

    16 与 32 px 用无针脚单色版，避免虚线针脚在小尺寸糊成一团。
    """
    bg = background or "transparent"
    return (
        '<!doctype html><html><body style="margin:0;background:%s;'
        'width:100vw;height:100vh;display:grid;place-items:center">'
        '<img src="%s" style="display:block;width:%svw;height:%svh">'
        "</body></html>" % (bg, mark, mark_ratio * 100, mark_ratio * 100)
    )


def build_masters() -> dict[int, str]:
    os.makedirs(ICONS, exist_ok=True)
    made: dict[int, str] = {}
    for size in SIZES:
        out = os.path.join(ICONS, f"icon-{size}.png")
        mark = "logo-mark-mono.svg" if size <= 32 else "logo-mark.svg"
        render(page_for(1.0, None, mark), size, out)
        made[size] = out

    # iOS 需要不透明底（系统不会补背景）；maskable 需要 20% 安全区。
    # 底色取品牌墨色，与标记自身底色同色：圆角与圆形裁切都不会露出白边。
    render(page_for(0.86, INK), 180, os.path.join(ICONS, "apple-touch-180.png"))
    render(page_for(0.74, INK), 512, os.path.join(ICONS, "maskable-512.png"))
    render(page_for(0.74, INK), 192, os.path.join(ICONS, "maskable-192.png"))
    return made


def build_ico(master: str, out: str) -> None:
    img = Image.open(master).convert("RGBA")
    img.save(
        out,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def build_icns(master_by_size: dict[int, str], out: str) -> None:
    """手写 ICNS：header + 若干 PNG 条目（macOS 10.7+ 支持 PNG 负载）。"""
    types = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
        (b"ic11", 32),
        (b"ic12", 64),
        (b"ic13", 256),
        (b"ic14", 512),
    ]
    chunks = b""
    for tag, size in types:
        with open(master_by_size[size], "rb") as f:
            payload = f.read()
        chunks += tag + struct.pack(">I", len(payload) + 8) + payload
    with open(out, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


ADMIN_INDIGO = "#1F4E79"
ADMIN_ACCENT = "#C0492F"


def build_admin_icon(master_by_size: dict[int, str]) -> None:
    """总管理端图标：靛蓝底 + 品牌标记 + 右下朱砂核对徽章。

    与租户端（墨色底）一眼区分：管理员开错标签页时能看出来。
    """
    with open(os.path.join(BRAND, "logo-mark.svg"), encoding="utf-8") as f:
        mark = f.read()
    inner = mark.split(">", 1)[1].rsplit("</svg>", 1)[0]
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
        f'<rect width="64" height="64" rx="14" fill="{ADMIN_INDIGO}"/>'
        f'<g transform="translate(9 9) scale(0.72)">{inner}</g>'
        f'<circle cx="51" cy="51" r="8" fill="{ADMIN_ACCENT}"/>'
        '<path d="M47 51l2.9 2.9L55.6 47.4" fill="none" stroke="#F7F4EE" '
        'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
        "</svg>"
    )
    admin_svg = os.path.join(BRAND, "admin-icon.svg")
    with open(admin_svg, "w", encoding="utf-8") as f:
        f.write(svg)

    app_dir = os.path.join(ROOT, "apps", "admin", "app")
    shutil.copyfile(admin_svg, os.path.join(app_dir, "icon.svg"))
    render(page_for(1.0, ADMIN_INDIGO, "admin-icon.svg"), 180, os.path.join(app_dir, "apple-icon.png"))
    tmp = os.path.join(ICONS, "admin-256.png")
    render(page_for(1.0, ADMIN_INDIGO, "admin-icon.svg"), 256, tmp)
    build_ico(tmp, os.path.join(app_dir, "favicon.ico"))
    os.unlink(tmp)


def copy_tree(master_by_size: dict[int, str]) -> None:
    svg = os.path.join(BRAND, "favicon.svg")

    # Next.js App Router：放在 app/ 下即自动生成 <link rel="icon"> 与 apple-touch-icon
    for app in ("web", "quote"):
        app_dir = os.path.join(ROOT, "apps", app, "app")
        shutil.copyfile(svg, os.path.join(app_dir, "icon.svg"))
        shutil.copyfile(
            os.path.join(ICONS, "apple-touch-180.png"), os.path.join(app_dir, "apple-icon.png")
        )
        build_ico(master_by_size[256], os.path.join(app_dir, "favicon.ico"))

    # 移动端 PWA：Taro 构建时把 src/pwa 拷到产物根目录，路径 /icons/* 直接可用
    pwa_icons = os.path.join(ROOT, "apps", "mobile", "src", "pwa", "icons")
    os.makedirs(pwa_icons, exist_ok=True)
    pairs = [
        ("icon-192.png", "icon-192.png"),
        ("icon-512.png", "icon-512.png"),
        ("maskable-192.png", "icon-maskable-192.png"),
        ("maskable-512.png", "icon-maskable-512.png"),
        ("apple-touch-180.png", "apple-touch-icon-180.png"),
    ]
    for src, dst in pairs:
        shutil.copyfile(os.path.join(ICONS, src), os.path.join(pwa_icons, dst))
    # 浏览器标签页 favicon（Taro 拷贝 src/pwa 到产物根，路径 /favicon.svg）
    shutil.copyfile(svg, os.path.join(ROOT, "apps", "mobile", "src", "pwa", "favicon.svg"))

    # 官网静态站也同步一份，避免两处各存一套旧图标
    site_icons = os.path.join(ROOT, "site", "assets", "icons")
    os.makedirs(site_icons, exist_ok=True)
    for size in (32, 180, 192, 512):
        shutil.copyfile(
            os.path.join(ICONS, f"icon-{size}.png"), os.path.join(site_icons, f"icon-{size}.png")
        )

    # Tauri 打印代理：bundle 需要的桌面图标合集
    tauri_icons = os.path.join(ROOT, "apps", "print-agent", "src-tauri", "icons")
    os.makedirs(tauri_icons, exist_ok=True)
    shutil.copyfile(master_by_size[512], os.path.join(tauri_icons, "icon.png"))
    shutil.copyfile(master_by_size[32], os.path.join(tauri_icons, "32x32.png"))
    shutil.copyfile(master_by_size[128], os.path.join(tauri_icons, "128x128.png"))
    shutil.copyfile(master_by_size[256], os.path.join(tauri_icons, "128x128@2x.png"))
    build_ico(master_by_size[256], os.path.join(tauri_icons, "icon.ico"))
    build_icns(master_by_size, os.path.join(tauri_icons, "icon.icns"))


if __name__ == "__main__":
    masters = build_masters()
    copy_tree(masters)
    build_admin_icon(masters)
    print("icons written:", ", ".join(str(s) for s in SIZES))
