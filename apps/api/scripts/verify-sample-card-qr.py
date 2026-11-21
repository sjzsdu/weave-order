#!/usr/bin/env python3
"""样卡标签二维码的渲染 + 解码校验（验收 5 的机器部分）。

为什么单独放一个脚本：`verify:sample-card` 只产出 ZPL 文本，而「二维码能不能扫出来」
必须在渲染后的位图上验证。这里用 Labelary（ZPL → PNG，8 dots/mm = 203dpi、
80×50mm 画布）模拟热敏打印栅格，再用 OpenCV 解码，与 labels.json 的预期 URL 比对。

注意：这是**打印栅格解码**，不等于「手机对纸扫码」。实物验收仍需在真机上完成。

用法：
  python3 scripts/verify-sample-card-qr.py <artifacts-dir>
  # <artifacts-dir> 需含 verify:sample-card 产出的 labels/ 与 labels.json
  # 例：pnpm --filter @weave-order/api verify:sample-card
  #     python3 apps/api/scripts/verify-sample-card-qr.py apps/api/.artifacts/sample-card

依赖：pip install opencv-python-headless requests
输出：<artifacts-dir>/label-png/*.png、decode-results.json、decode-summary.md
"""
import glob
import json
import os
import sys

import cv2
import requests

LABELARY = "http://api.labelary.com/v1/printers/8dpmm/labels/3.15x1.97/0/"


def render(zpl_path: str, png_path: str) -> None:
    with open(zpl_path, "rb") as fh:
        response = requests.post(
            LABELARY,
            data=fh.read(),
            headers={"Accept": "image/png"},
            timeout=30,
        )
    response.raise_for_status()
    with open(png_path, "wb") as fh:
        fh.write(response.content)


def decode_qr(path: str) -> str:
    """多尺度尝试：部分图案在原始像素上解码失败，放大 2 倍即可（手机取景同理）。"""
    image = cv2.imread(path)
    detector = cv2.QRCodeDetector()
    for scale in (1, 2):
        candidate = image if scale == 1 else cv2.resize(
            image, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST
        )
        for frame in (candidate, cv2.threshold(
            cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY), 128, 255, cv2.THRESH_BINARY
        )[1]):
            text, _, _ = detector.detectAndDecode(frame)
            if text:
                return text
    return ""


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    manifest = json.load(open(os.path.join(root, "labels.json"), encoding="utf-8"))
    expected = {
        os.path.basename(row["file"]).replace(".zpl", ""): row for row in manifest
    }
    png_dir = os.path.join(root, "label-png")
    os.makedirs(png_dir, exist_ok=True)

    results = []
    for zpl_path in sorted(glob.glob(os.path.join(root, "labels", "*.zpl"))):
        key = os.path.basename(zpl_path).replace(".zpl", "")
        png_path = os.path.join(png_dir, f"{key}.png")
        render(zpl_path, png_path)
        text = decode_qr(png_path)
        row = expected.get(key)
        results.append(
            {
                "file": key,
                "code": row["code"] if row else None,
                "expected": row["qrPayload"] if row else None,
                "decoded": text,
                "ok": bool(text) and (row is None or text == row["qrPayload"]),
            }
        )

    passed = sum(1 for row in results if row["ok"])
    with open(os.path.join(root, "decode-results.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)

    lines = [
        "| # | 样品编号 | 解码 | 一致 |",
        "| --- | --- | --- | --- |",
    ]
    for index, row in enumerate(results, 1):
        lines.append(
            f"| {index} | {row['code'] or row['file']} | "
            f"{'可解码' if row['decoded'] else '无法解码'} | {'✅' if row['ok'] else '❌'} |"
        )
    summary = f"# 二维码解码结果\n\n{passed}/{len(results)} 可解码且与预期一致。\n\n" + "\n".join(
        lines
    )
    with open(os.path.join(root, "decode-summary.md"), "w", encoding="utf-8") as fh:
        fh.write(summary + "\n")

    print(f"{passed}/{len(results)} 可解码且与预期一致")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
