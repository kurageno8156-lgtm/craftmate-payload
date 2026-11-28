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
OS="${2:-$(uname -s | tr '[:upper:]' '[:lower:]')}"   # linux | darwin | win32
# Git Bash / MSYS / Cygwin の uname は MINGW64_NT-* 等を返すため win32 に正規化
case "$OS" in
  mingw*|msys*|cygwin*) OS=win32 ;;
esac
ARCH="${3:-$(uname -m)}"                                # x64 | arm64 | aarch64
# Git Bash / MSYS の uname -m は x86_64 を返す。Node.js 公式配布物の
# ディレクトリ名は win-x64 / linux-x64 等なので必ず正規化する。
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64)      ARCH=arm64 ;;
esac

OUT_NAME="craftmate-${OS}-${ARCH}"
STAGE="$(mktemp -d)/${OUT_NAME}"

echo "==> BlockWhiz ${VERSION} build (${OS}/${ARCH})"

# 同梱する Node.js ランタイムのバージョン。
# better-sqlite3 のプリビルドは Node.js v22 の ABI 向けのため、
# npm ci / npm rebuild を実行する「ビルドマシンの Node.js」も
# メジャーバージョンを揃える必要がある（不一致だと実行時に SIGSEGV）。
# 不一致のまま進めると ABI 不一致の配布物ができてしまうため、警告ではなく停止する。
NODE_VERSION="v22.20.0"
BUILD_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo '?')"
BUNDLED_NODE_MAJOR="${NODE_VERSION#v}"; BUNDLED_NODE_MAJOR="${BUNDLED_NODE_MAJOR%%.*}"
if [ "$BUILD_NODE_MAJOR" != "$BUNDLED_NODE_MAJOR" ]; then
  echo "ERROR: build Node.js is $(node -v 2>/dev/null || echo '?') but bundled runtime is ${NODE_VERSION}."
  echo "       better-sqlite3 prebuilds target Node.js ${BUNDLED_NODE_MAJOR}.x ABI."
  echo "       Re-run this script with Node.js ${BUNDLED_NODE_MAJOR}.x (e.g. via nvm/volta/fnm)."
  exit 1
fi

# 1) 依存インストール（install scripts はスキップ）
#    better-sqlite3 は prebuilds/ に win32/linux/darwin × x64/arm64 の
#    プリビルドを同梱しており node-gyp ビルドは不要（CI と同じ方式）。
#    install scripts を有効にすると better-sqlite3 が node-gyp を起動し、
#    VS 未導入環境では失敗する。esbuild の postinstall のみ手動実行する。
npm ci --ignore-scripts
node node_modules/esbuild/install.js

# 2) ネイティブモジュールの再ビルドは不要
#    better-sqlite3 のプリビルドは Node.js v22 ABI 向け。
#    上の NODE_VERSION ガードによりビルドマシンも Node.js 22.x 必須。

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
case "$OS" in
  linux)  NODE_DIST="linux-${ARCH}" ;;
  darwin) NODE_DIST="darwin-${ARCH}" ;;
  win32)  NODE_DIST="win-${ARCH}" ;;
  *)      NODE_DIST="" ;;
esac
if [ -n "$NODE_DIST" ]; then
  echo "==> Downloading Node.js ${NODE_VERSION} (${NODE_DIST})"
  # win32 の公式配布物は .zip、Linux/macOS は .tar.xz
  if [ "$OS" = "win32" ]; then
    NODE_TAR="node-${NODE_VERSION}-${NODE_DIST}.zip"
  else
    NODE_TAR="node-${NODE_VERSION}-${NODE_DIST}.tar.xz"
  fi
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt
  EXPECTED="$(grep " ${NODE_TAR}\$" /tmp/SHASUMS256.txt | awk '{print $1}')"
  [ -n "$EXPECTED" ] || { echo "ERROR: ${NODE_TAR} not found in SHASUMS256.txt"; exit 1; }
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}" -o "/tmp/${NODE_TAR}"
  ACTUAL="$(sha256sum "/tmp/${NODE_TAR}" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "ERROR: SHA256 mismatch for ${NODE_TAR}"; exit 1; }
  echo "==> SHA256 verified: ${ACTUAL}"
  rm -f /tmp/SHASUMS256.txt
  NODE_EXTRACT="$(mktemp -d)/node-${NODE_VERSION}-${NODE_DIST}"
  mkdir -p "$NODE_EXTRACT"
  if [ "$OS" = "win32" ]; then
    # zip はトップレベルに node-vX.Y.Z-win-x64/ を含むため、その中身を展開先にする
    unzip -q -o "/tmp/${NODE_TAR}" -d "$NODE_EXTRACT"
    NODE_EXTRACT="$NODE_EXTRACT/node-${NODE_VERSION}-${NODE_DIST}"
  else
    tar -xJf "/tmp/${NODE_TAR}" -C "$NODE_EXTRACT" --strip-components=1
  fi
  mkdir -p "$STAGE/runtime"
  if [ "$OS" = "win32" ]; then
    # Windows は node.exe を craftmate-node.exe として同梱する
    cp "$NODE_EXTRACT/node.exe" "$STAGE/craftmate-node.exe"
  else
    cp "$NODE_EXTRACT/bin/node" "$STAGE/craftmate-node"
    chmod +x "$STAGE/craftmate-node"
  fi
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
Name=BlockWhiz
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
  echo "BlockWhiz をアプリケーションメニューに登録しました: $APPS_DIR/craftmate.desktop"
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$HOME/.local/share/applications/craftmate.desktop" \
        "$HOME/.local/share/icons/hicolor/256x256/apps/craftmate.png"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "BlockWhiz のデスクトップ登録を削除しました。"
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
BlockWhiz ${VERSION} (${OS}/${ARCH}) — ポータブル版

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
sha256sum "${OUT_NAME}.tar.gz" > "${OUT_NAME}.tar.gz.sha256"
echo "==> Created ${OUT_NAME}.tar.gz ($(du -h "${OUT_NAME}.tar.gz" | cut -f1))"
echo "==> Wrote ${OUT_NAME}.tar.gz.sha256"

# 7) Electron ラッパー用に payload をリポジトリ直下へコピー
#    (electron-builder の extraResources が ../craftmate-payload を参照する)
if [ "${SKIP_PAYLOAD_COPY:-0}" != "1" ]; then
  rm -rf craftmate-payload
  cp -r "$STAGE" craftmate-payload
  echo "==> Staged payload for Electron at ./craftmate-payload"
fi
