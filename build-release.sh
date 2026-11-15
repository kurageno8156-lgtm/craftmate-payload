#!/usr/bin/env bash
# ============================================================
# CraftMate マルチプラットフォームビルドスクリプト (Linux / macOS)
#
# 使い方:
#   ./build-release.sh [version] [os] [arch]
#   例: ./build-release.sh 1.4.0 linux x64
#       ./build-release.sh 1.4.0 darwin arm64
#
# 出力:
#   craftmate-<os>-<arch>.tar.gz  … Node.js不要で動くポータブルtarball
#     - dist/ public/ node_modules/ package.json
#     - start.sh (node dist/index.js を起動)
#     - README-PORTABLE.txt
#
# 注意:
#   - Windows版の Setup.exe / Launcher.exe / Updater.exe は
#     installer/Build-Release.ps1 (PowerShell + csc.exe) が担当。
#     このスクリプトは C# に依存しない Node.js 直起動方式。
#   - better-sqlite3 はネイティブモジュールのため、必ず対象OS上で
#     npm ci / npm rebuild を実行すること（クロスコンパイル不可）。
# ============================================================
set -euo pipefail

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo dev)}"
OS="${2:-$(uname -s | tr '[:upper:]' '[:lower:]')}"   # linux | darwin
ARCH="${3:-$(uname -m)}"                                # x64 | arm64 | aarch64
case "$ARCH" in aarch64) ARCH=arm64 ;; esac

OUT_NAME="craftmate-${OS}-${ARCH}"
STAGE="$(mktemp -d)/${OUT_NAME}"

echo "==> CraftMate ${VERSION} build (${OS}/${ARCH})"

# 1) 依存インストール（対象OSの prebuilt を取得）
npm ci

# 2) ネイティブモジュールを対象プラットフォーム向けに再ビルド
#    prebuilt が無い場合のみソースビルド（python3/make/g++ or xcode CLT が必要）
npm rebuild better-sqlite3 || {
  echo "!! better-sqlite3 rebuild failed; trying source build..."
  npm rebuild better-sqlite3 --build-from-source
}

# 3) TypeScript ビルド
npm run build

# 4) 必須ファイルの検証
for f in dist/index.js package.json public/index.html public/app.js; do
  [ -f "$f" ] || { echo "ERROR: missing $f"; exit 1; }
done
[ -d node_modules ] || { echo "ERROR: node_modules missing"; exit 1; }

# 5) ポータブルステージング
mkdir -p "$STAGE"
cp -r dist public node_modules package.json package-lock.json "$STAGE"/ 2>/dev/null || true
cp .env.example "$STAGE"/ 2>/dev/null || true

cat > "$STAGE/start.sh" <<'EOF'
#!/usr/bin/env bash
# CraftMate 起動スクリプト — Node.js が PATH にある環境で実行
cd "$(dirname "$0")"
exec node dist/index.js "$@"
EOF
chmod +x "$STAGE/start.sh"

cat > "$STAGE/README-PORTABLE.txt" <<EOF
CraftMate ${VERSION} (${OS}/${ARCH}) — ポータブル版

【起動方法】
  1. Node.js 18+ をインストール（https://nodejs.org）
  2. このフォルダで ./start.sh を実行
  3. ブラウザで http://localhost:3000 を開く

【注意】
  - better-sqlite3 はこのプラットフォーム用にビルド済みです。
    別OSへコピーした場合は npm rebuild better-sqlite3 が必要です。
  - APIキー等は .env に設定してください（.env.example 参照）。
EOF

# 6) tarball 作成
tar -czf "${OUT_NAME}.tar.gz" -C "$(dirname "$STAGE")" "$(basename "$STAGE")"
echo "==> Created ${OUT_NAME}.tar.gz ($(du -h "${OUT_NAME}.tar.gz" | cut -f1))"

# 7) Electron ラッパー用に payload をリポジトリ直下へコピー
#    (electron-builder の extraResources が ../craftmate-payload を参照する)
if [ "${SKIP_PAYLOAD_COPY:-0}" != "1" ]; then
  rm -rf craftmate-payload
  cp -r "$STAGE" craftmate-payload
  echo "==> Staged payload for Electron at ./craftmate-payload"
fi
