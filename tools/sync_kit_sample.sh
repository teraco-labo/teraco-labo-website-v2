#!/bin/bash
# AI講座キット（~/Documents/GitHub/teraco-ai-kit）の無料見本（第1回）を、サイトの gift/kit-sample/ に写す。
# キットを組み立て直したら（bash deck/build_all.sh のあと）これを走らせ、git で変わった所を見てから公開する。
# 見本は PDF だけ（直して使えるパワポ・投影用スライドは製品版に残す。2026-10-27 藤崎さん「PDF だけすぐ渡す」）
set -euo pipefail
ZIP="$HOME/Documents/GitHub/teraco-ai-kit/配布用/未来を描くAI講座_無料サンプル_第1回.zip"
OUT="$(cd "$(dirname "$0")/.." && pwd)/gift/kit-sample"
TMP="$(mktemp -d)"
ditto -x -k "$ZIP" "$TMP"
SRC="$TMP/未来を描くAI講座_無料サンプル_第1回"
cp "$SRC/00_はじめにお読みください.pdf"                 "$OUT/00_hajimeni.pdf"
cp "$SRC/第1回_AIの基本を知る/第1回_AIの基本を知る_スライド.pdf"     "$OUT/01_slide.pdf"
cp "$SRC/第1回_AIの基本を知る/第1回_AIの基本を知る_講師台本.pdf"     "$OUT/02_daihon.pdf"
cp "$SRC/第1回_AIの基本を知る/第1回_AIの基本を知る_ワークシート.pdf" "$OUT/03_worksheet.pdf"
cp "$SRC/01_準備チェックリスト.pdf"                     "$OUT/04_checklist.pdf"
cp "$SRC/02_よくあるエラーと対処法.pdf"                 "$OUT/05_errors.pdf"
echo "写しました: $OUT（元の zip の日付: $(stat -f %Sm "$ZIP")）"
