#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""てらこ先生の名刺ページ（https://teraco-labo.com/sensei/）の QR コード一式を作る。

2026-10-06 藤崎さんの決定：
- URL は teraco-labo.com/sensei（講座で口で言える短さ）
- QR は深緑＋真ん中にてらこ先生の顔
- 使い道ごとに QR を分けて、どこから来た人が多いかを数える（行き先は同じページ）
  名刺＝card、講座＝class、SNS＝sns（Google アナリティクスの「参照元」に出る）

実行: ~/.venvs/teraco-qr/bin/python tools/make_qr.py
（segno・zxing-cpp・Pillow が入った環境。作ったあと全部読み取れるか自分で確かめる）
出力: sensei/qr/
"""
from pathlib import Path

import segno
import zxingcpp
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "sensei" / "qr"
FACE = Path(__file__).resolve().parent / "face_qr.png"

BASE = "https://teraco-labo.com/sensei/"
VARIANTS = {
    "card": "名刺用",
    "class": "講座用",
    "sns": "SNS用",
    "plain": "そのほか（数えない）",
}
GREEN = (47, 93, 70)      # #2F5D46 深緑
WHITE = (255, 255, 255)


def url_for(key: str) -> str:
    return BASE if key == "plain" else f"{BASE}?utm_source={key}"


def draw_qr(data: str, size: int = 2400) -> Image.Image:
    """深緑の QR。真ん中に白い丸と顔（誤り訂正 H なので面積の約30%まで隠せる。顔はその半分以下）。"""
    qr = segno.make(data, error="h", boost_error=False)
    matrix = [list(r) for r in qr.matrix]
    n = len(matrix)
    quiet = 4
    cell = size // (n + quiet * 2)
    full = cell * (n + quiet * 2)
    img = Image.new("RGB", (full, full), WHITE)
    d = ImageDraw.Draw(img)
    for y, row in enumerate(matrix):
        for x, v in enumerate(row):
            if v:
                x0, y0 = (x + quiet) * cell, (y + quiet) * cell
                d.rectangle([x0, y0, x0 + cell - 1, y0 + cell - 1], fill=GREEN)
    # 真ん中の顔：QR 一辺の 24%（面積で約 4.5%）
    fd = int(n * cell * 0.24)
    ring = int(cell * 0.9)
    cx = cy = full // 2
    d.ellipse([cx - fd // 2 - ring, cy - fd // 2 - ring, cx + fd // 2 + ring, cy + fd // 2 + ring], fill=WHITE)
    face = Image.open(FACE).convert("RGB").resize((fd, fd), Image.LANCZOS)
    mask = Image.new("L", (fd, fd), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, fd - 1, fd - 1], fill=255)
    img.paste(face, (cx - fd // 2, cy - fd // 2), mask)
    d.ellipse([cx - fd // 2, cy - fd // 2, cx + fd // 2, cy + fd // 2], outline=GREEN, width=max(2, cell // 3))
    return img.resize((size, size), Image.LANCZOS)


def check(img: Image.Image, expect: str) -> list:
    """いろいろな大きさに縮めて読めるか。名刺に2cmで刷ったときの見え方に近い小ささまで試す。"""
    results = []
    for px in (1200, 400, 200, 120, 90):
        small = img.resize((px, px), Image.LANCZOS)
        found = zxingcpp.read_barcodes(small)
        ok = any(b.text == expect for b in found)
        results.append((px, ok))
    return results


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = []
    for key, label in VARIANTS.items():
        data = url_for(key)
        img = draw_qr(data)
        path = OUT / f"qr-{key}.png"
        img.save(path, optimize=True)
        res = check(img, data)
        qr = segno.make(data, error="h", boost_error=False)
        report.append((key, label, data, qr.designator, res))
        ok_all = all(ok for _, ok in res)
        print(f"{'OK ' if ok_all else 'NG '} {label:<14} {qr.designator:<4} {data}")
        print("     読み取り: " + "  ".join(f"{px}px={'○' if ok else '×'}" for px, ok in res))
    return report


if __name__ == "__main__":
    main()
