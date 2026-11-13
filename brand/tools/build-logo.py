"""weave-order 品牌标识生成器。

依赖：fontTools + 系统字体 Noto Serif CJK SC (Bold) / Noto Sans (Regular)。
用法：python3 brand/tools/build-logo.py
产物：brand/*.svg 与 brand/icons/*.png（PNG 由 Chrome 无头渲染，见 brand/README.md）
"""
import os
import re

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont, TTCollection

INK = "#14202B"
PAPER = "#F7F4EE"
INDIGO = "#1F4E79"
VERMILION = "#C0492F"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SERIF = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"
SANS = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
SANS_BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"


class Face:
    def __init__(self, path, index=0):
        if path.endswith(".ttc"):
            coll = TTCollection(path)
            self.font = coll.fonts[index]
        else:
            self.font = TTFont(path)
        self.glyphs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.upm = self.font["head"].unitsPerEm
        self.hmtx = self.font["hmtx"]

    def glyph(self, ch):
        return self.cmap[ord(ch)]

    def path(self, ch):
        pen = SVGPathPen(self.glyphs)
        self.glyphs[self.glyph(ch)].draw(pen)
        return pen.getCommands()

    def advance(self, ch):
        return self.hmtx[self.glyph(ch)][0]


def text_path(face, text, size, x, y, tracking=0.0):
    """返回 (path_d, 总宽)，y 为基线，坐标 y 向下。"""
    s = size / face.upm
    out = []
    cursor = 0.0
    for ch in text:
        d = face.path(ch)
        out.append(
            f'<path transform="translate({x + cursor:.2f} {y:.2f}) scale({s:.6f} {-s:.6f})" d="{d}"/>'
        )
        cursor += face.advance(ch) * s + tracking
    return "\n  ".join(out), cursor - tracking if text else 0


def glyph_block(face, ch, cx, cy, height, fill):
    """按字符实际墨迹包围盒居中放置。"""
    from fontTools.pens.boundsPen import BoundsPen

    bp = BoundsPen(face.glyphs)
    face.glyphs[face.glyph(ch)].draw(bp)
    x0, y0, x1, y1 = bp.bounds
    w, h = x1 - x0, y1 - y0
    s = height / h
    tx = cx - (x0 + w / 2) * s
    ty = cy + (y0 + h / 2) * s
    d = face.path(ch)
    return f'<path transform="translate({tx:.2f} {ty:.2f}) scale({s:.6f} {-s:.6f})" d="{d}" fill="{fill}"/>'


# ---------------------------------------------------------------- 织标 mark

def mark_svg(bg=INK, glyph=PAPER, stitch=PAPER, stitch_opacity="0.42", radius=14.0, size=64):
    serif = Face(SERIF, index=2)
    stitch_color = stitch if stitch_opacity == "1" else stitch
    inner = [
        f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg}"/>',
        f'<rect x="4.3" y="4.3" width="{size - 8.6}" height="{size - 8.6}" rx="{radius - 4.6}" '
        f'fill="none" stroke="{stitch_color}" stroke-opacity="{stitch_opacity}" '
        f'stroke-width="1.35" stroke-dasharray="2.6 2.3" stroke-linecap="round"/>',
        glyph_block(serif, "织", size / 2, size / 2 + 0.4, 34.5, glyph),
    ]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">\n  '
        + "\n  ".join(inner)
        + "\n</svg>\n"
    )


def mark_mono_svg(color=INK, knockout=False):
    """单色版：用于单色印刷、favicon、图标库（无虚线，保证小尺寸清晰）。

    knockout=True 时字形为透明镂空（叠在任意底色上都可读），用于反白场景。
    """
    serif = Face(SERIF, index=2)
    # 镂空版用纯黑建蒙版，实心版直接画米白字
    glyph = glyph_block(serif, "织", 32, 32.4, 40.0, "#000" if knockout else PAPER)
    if knockout:
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">\n'
            f'  <mask id="knockout"><rect width="64" height="64" fill="#fff"/>'
            f'<g fill="#000">{glyph}</g></mask>\n'
            f'  <rect width="64" height="64" rx="14" fill="{color}" mask="url(#knockout)"/>\n'
            "</svg>\n"
        )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">\n  '
        f'<rect width="64" height="64" rx="14" fill="{color}"/>\n  '
        + glyph
        + "\n</svg>\n"
    )


# ------------------------------------------------------------ 横版 lockup

def lockup_svg(ink=INK, sub=INK, inverse=False):
    serif = Face(SERIF, index=2)
    sans = Face(SANS_BOLD)
    wordmark, latin = "织序", "WEAVE ORDER"
    mark = (
        mark_svg(bg=PAPER, glyph=INK, stitch=INK, stitch_opacity="0.30")
        if inverse
        else mark_svg()
    )
    body = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", mark).strip()
    cn, cn_w = text_path(serif, wordmark, 26, 72, 34.5, tracking=1.6)
    # 英文副行与中文行等宽：字号固定，用字距补齐
    latin_path, latin_w = text_path(sans, latin, 8.0, 73.0, 49.0, tracking=1.9)
    width = max(72 + cn_w, 73.0 + latin_w) + 8
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} 64" width="{width:.0f}" height="64">\n'
        f'  <g>{body}</g>\n'
        f'  <g fill="{ink}">\n  {cn}\n  </g>\n'
        f'  <g fill="{sub}" fill-opacity="0.72">\n  {latin_path}\n  </g>\n'
        "</svg>\n"
    )


def wordmark_svg(ink=INK, sub=INK):
    serif = Face(SERIF, index=2)
    sans = Face(SANS_BOLD)
    cn, cn_w = text_path(serif, "织序", 30, 2, 38, tracking=2.2)
    latin_path, latin_w = text_path(sans, "WEAVE ORDER", 8.4, 3.4, 55, tracking=2.6)
    width = max(2 + cn_w, 3.4 + latin_w) + 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} 62" width="{width:.0f}" height="62">\n'
        f'  <g fill="{ink}">\n  {cn}\n  </g>\n'
        f'  <g fill="{sub}" fill-opacity="0.72">\n  {latin_path}\n  </g>\n'
        "</svg>\n"
    )


def favicon_svg():
    return mark_mono_svg(INK).replace('width="64" height="64"', 'width="64" height="64"')


FILES = {
    "logo-mark.svg": lambda: mark_svg(),
    "logo-mark-inverse.svg": lambda: mark_svg(bg=PAPER, glyph=INK, stitch=INK, stitch_opacity="0.30"),
    "logo-mark-mono.svg": lambda: mark_mono_svg(INK),
    "logo-mark-mono-inverse.svg": lambda: mark_mono_svg(PAPER, knockout=True),
    "logo-horizontal.svg": lambda: lockup_svg(),
    "logo-horizontal-inverse.svg": lambda: lockup_svg(ink=PAPER, sub=PAPER, inverse=True),
    "logo-wordmark.svg": lambda: wordmark_svg(),
    "logo-wordmark-inverse.svg": lambda: wordmark_svg(ink=PAPER, sub=PAPER),
    "favicon.svg": lambda: mark_mono_svg(INK),
}

if __name__ == "__main__":
    for name, fn in FILES.items():
        with open(os.path.join(ROOT, name), "w", encoding="utf-8") as f:
            f.write(fn())
        print("wrote", name)
