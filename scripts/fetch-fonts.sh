#!/usr/bin/env bash
# Download CJK fonts for deterministic rendering (satori requires TTF/OTF).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/render-engine/assets/fonts"
mkdir -p "$DIR"
BASE="https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese"
[ -f "$DIR/NotoSansSC-Regular.otf" ] || curl -sSL -o "$DIR/NotoSansSC-Regular.otf" "$BASE/NotoSansCJKsc-Regular.otf"
[ -f "$DIR/NotoSansSC-Bold.otf" ] || curl -sSL -o "$DIR/NotoSansSC-Bold.otf" "$BASE/NotoSansCJKsc-Bold.otf"
echo "fonts ready in $DIR"
