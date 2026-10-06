#!/bin/bash
# 名刺ページの配布物を画像にする（qr_cards.html → sensei/img/og*.png・sensei/qr/）
# 先に make_qr.py で QR を作っておくこと
#   標準（ふつうの絵のてらこ先生）: sensei/img/og.png・sensei/qr/*.png
#   ちびキャラ版:                  sensei/img/og-chibi.png・sensei/qr/chibi/*.png
cd "$(dirname "$0")"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot(){ "$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=$2 --screenshot="$3" "file://$PWD/qr_cards.html$4#$1" >/dev/null 2>&1; echo "$3"; }
shot og 1200,630 ../sensei/img/og.png
shot class 1920,1080 ../sensei/qr/slide-class.png
shot sns 1080,1350 ../sensei/qr/sns-post.png
shot meishi 1075,650 ../sensei/qr/meishi-back.png
mkdir -p ../sensei/qr/chibi
shot og 1200,630 ../sensei/img/og-chibi.png "?face=chibi"
shot class 1920,1080 ../sensei/qr/chibi/slide-class.png "?face=chibi"
shot sns 1080,1350 ../sensei/qr/chibi/sns-post.png "?face=chibi"
shot meishi 1075,650 ../sensei/qr/chibi/meishi-back.png "?face=chibi"
