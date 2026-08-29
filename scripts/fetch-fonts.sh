#!/usr/bin/env bash
# Download Noto Sans SC (OFL license) for Satori deterministic rendering.
# Fonts are gitignored; the Docker build also runs this script.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_DIR="$ROOT_DIR/packages/render-engine/assets/fonts"
mkdir -p "$FONT_DIR"

FONT_BASES=(
  "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese"
  "https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/SimplifiedChinese"
)

fetch() {
  # $1 = 远端文件名（noto-cjk 仓库命名），$2 = 本地文件名（render-engine 期望）
  local remote="$1"
  local file="$2"
  if [ -s "$FONT_DIR/$file" ]; then
    echo "[skip] $file already present"
    return 0
  fi
  for base in "${FONT_BASES[@]}"; do
    echo "[fetch] $remote from $base"
    if curl -fsSL --retry 2 -o "$FONT_DIR/$file.part" "$base/$remote"; then
      mv "$FONT_DIR/$file.part" "$FONT_DIR/$file"
      echo "[ok] $file"
      return 0
    fi
  done
  rm -f "$FONT_DIR/$file.part"
  echo "[fail] could not download $remote" >&2
  return 1
}

fetch "NotoSansCJKsc-Regular.otf" "NotoSansSC-Regular.otf"
fetch "NotoSansCJKsc-Bold.otf" "NotoSansSC-Bold.otf"

cat > "$FONT_DIR/LICENSE" <<'EOF'
Noto Sans CJK SC
Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source".
This Font Software is licensed under the SIL Open Font License, Version 1.1.
https://openfontlicense.org
EOF

echo "fonts ready: $FONT_DIR"
