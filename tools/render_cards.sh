#!/bin/bash
# 名刺ページの配布物を画像にする（qr_cards.html → sensei/img/og.png・sensei/qr/*.png）
# 先に make_qr.py で QR を作っておくこと
cd "$(dirname "$0")"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot(){ "$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=$2 --screenshot="$3" "file://$PWD/qr_cards.html#$1" >/dev/null 2>&1; echo "$3"; }
shot og 1200,630 ../sensei/img/og.png
shot class 1920,1080 ../sensei/qr/slide-class.png
shot sns 1080,1350 ../sensei/qr/sns-post.png
shot meishi 1075,650 ../sensei/qr/meishi-back.png
