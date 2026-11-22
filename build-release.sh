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

# 5) Node.js ランタイム同梱
#    Electron を ELECTRON_RUN_AS_NODE で Node として使うと、ネイティブモジュール
#    (better-sqlite3) が Electron の ABI と不一致で SIGSEGV するため、
#    対象プラットフォーム用の公式 Node.js バイナリを同梱する。
NODE_VERSION="v20.18.1"
case "$OS" in
  linux)  NODE_DIST="linux-${ARCH}" ;;
  darwin) NODE_DIST="darwin-${ARCH}" ;;
  *)      NODE_DIST="" ;;
esac
if [ -n "$NODE_DIST" ]; then
  echo "==> Downloading Node.js ${NODE_VERSION} (${NODE_DIST})"
  NODE_TAR="node-${NODE_VERSION}-${NODE_DIST}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}" -o "/tmp/${NODE_TAR}"
  NODE_EXTRACT="$(mktemp -d)/node-${NODE_VERSION}-${NODE_DIST}"
  mkdir -p "$NODE_EXTRACT"
  tar -xJf "/tmp/${NODE_TAR}" -C "$NODE_EXTRACT" --strip-components=1
  mkdir -p "$STAGE/runtime"
  cp "$NODE_EXTRACT/bin/node" "$STAGE/craftmate-node"
  chmod +x "$STAGE/craftmate-node"
  rm -rf "$NODE_EXTRACT" "/tmp/${NODE_TAR}"
  echo "==> Bundled Node.js runtime: $($STAGE/craftmate-node --version 2>/dev/null || echo OK)"
fi

# 6) ポータブルステージング
mkdir -p "$STAGE"
cp -r dist public node_modules package.json package-lock.json "$STAGE"/ 2>/dev/null || true
cp .env.example "$STAGE"/ 2>/dev/null || true
# OAuth クライアント設定（oauth-clients.json）は Client Secret を含むため配布物に同梱しない。
# ユーザーは %LOCALAPPDATA%\CraftMate\oauth-clients.json 等に自分で配置する。
# デスクトップ登録用アイコン（electron/icon.png = app.ico 由来 256x256）
cp electron/icon.png "$STAGE/craftmate.png" 2>/dev/null || true

cat > "$STAGE/start.sh" <<'EOF'
#!/usr/bin/env bash
# CraftMate 起動スクリプト — 同梱の Node.js を優先、無ければ PATH の node を使用
cd "$(dirname "$0")"

# ./start.sh --install : アプリケーションメニューに登録して終了
if [ "${1:-}" = "--install" ]; then
  APPS_DIR="$HOME/.local/share/applications"
  ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
  mkdir -p "$APPS_DIR" "$ICON_DIR"
  START_PATH="$(pwd)/start.sh"
  cat > "$APPS_DIR/craftmate.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=CraftMate
Comment=Minecraft AI autonomous agent
Exec="$START_PATH" %U
Icon=craftmate
Terminal=false
Categories=Utility;Game;
StartupNotify=true
DESK
  [ -f ./craftmate.png ] && cp ./craftmate.png "$ICON_DIR/craftmate.png"
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  echo "CraftMate をアプリケーションメニューに登録しました: $APPS_DIR/craftmate.desktop"
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$HOME/.local/share/applications/craftmate.desktop" \
        "$HOME/.local/share/icons/hicolor/256x256/apps/craftmate.png"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "CraftMate のデスクトップ登録を削除しました。"
  exit 0
fi

if [ -x ./craftmate-node ]; then
  exec ./craftmate-node dist/index.js "$@"
elif command -v node >/dev/null 2>&1; then
  exec node dist/index.js "$@"
else
  echo "ERROR: Node.js が見つかりません。同梱ランタイムが破損している可能性があります。" >&2
  exit 1
fi
EOF
chmod +x "$STAGE/start.sh"

cat > "$STAGE/README-PORTABLE.txt" <<EOF
CraftMate ${VERSION} (${OS}/${ARCH}) — ポータブル版

【起動方法】
  1. Node.js 18+ をインストール（https://nodejs.org）
  2. このフォルダで ./start.sh を実行
  3. ブラウザで http://localhost:3000 を開く

【アプリケーションメニューへの登録（任意）】
  ./start.sh --install    … メニューに登録
  ./start.sh --uninstall  … 登録を解除

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
