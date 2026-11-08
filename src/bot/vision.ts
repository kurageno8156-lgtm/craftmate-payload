import { execFile } from 'child_process';

// 画面の指定領域をキャプチャし、640x360にリサイズしてBase64形式で返す
// screenshot-desktop / sharp が利用できない環境でもアプリ起動を妨げないよう、
// 依存モジュールは必要になった時点で動的に読み込み、失敗時は null を返す。

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Minecraftウィンドウの矩形をキャッシュ（画面共有中に毎フレームPowerShellを起動しないよう2秒間隔で再取得）
let cachedWindowRect: WindowRect | null = null;
let windowRectCacheTime = 0;
let lastFallbackLogTime = 0;
let lastDetectLogTime = 0;
const WINDOW_RECT_CACHE_MS = 2000;
const FALLBACK_LOG_INTERVAL_MS = 30000;

const WINDOW_RECT_SCRIPT = [
  "$code = @'",
  "using System;",
  "using System.Text;",
  "using System.Runtime.InteropServices;",
  "public class WinEnum {",
  "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
  "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);",
  "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);",
  "  public struct RECT { public int Left, Top, Right, Bottom; }",
  "}",
  "'@",
  "Add-Type -TypeDefinition $code",
  "$script:target = [IntPtr]::Zero",
  "$cb = [WinEnum+EnumProc]{ param($h,$l)",
  "  if (-not [WinEnum]::IsWindowVisible($h)) { return $true }",
  "  if ([WinEnum]::IsIconic($h)) { return $true }",
  "  $sb = New-Object System.Text.StringBuilder 256",
  "  [void][WinEnum]::GetWindowText($h, $sb, 256)",
  "  $title = $sb.ToString()",
  "  $cn = New-Object System.Text.StringBuilder 256",
  "  [void][WinEnum]::GetClassName($h, $cn, 256)",
  "  $className = $cn.ToString()",
  "  # Minecraft Java版のウィンドウクラス名は GLFW30。タイトル変更・別名でも確実に検出できる",
  "  if ($className -eq 'GLFW30') { $script:target = $h; return $false }",
  "  if ($title -match 'Minecraft' -and $title -notmatch 'Launcher|ScreenViewer|CraftMate|画面共有') { $script:target = $h; return $false }",
  "  return $true",
  "}",
  "[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)",
  "if ($script:target -eq [IntPtr]::Zero) { 'notfound'; exit }",
  "$rect = New-Object WinEnum+RECT",
  "[void][WinEnum]::GetWindowRect($script:target, [ref]$rect)",
  "'{0},{1},{2},{3}' -f $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)",
].join('\n');

/**
 * Minecraftウィンドウの矩形を取得（2秒キャッシュ）。
 * ウィンドウが見つからない・最小化されている場合は null。
 */
function getMinecraftWindowRect(): Promise<WindowRect | null> {
  if (Date.now() - windowRectCacheTime < WINDOW_RECT_CACHE_MS) {
    return Promise.resolve(cachedWindowRect);
  }
  windowRectCacheTime = Date.now();

  return new Promise(resolve => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOW_RECT_SCRIPT],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          cachedWindowRect = null;
          return resolve(null);
        }
        const parts = String(stdout).trim().split(',');
        if (parts.length !== 4) {
          cachedWindowRect = null;
          return resolve(null);
        }
        const [x, y, width, height] = parts.map(v => Number(v.trim()));
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
          cachedWindowRect = null;
          return resolve(null);
        }
        cachedWindowRect = { x, y, width, height };
        if (Date.now() - lastDetectLogTime > 30000) {
          lastDetectLogTime = Date.now();
          console.log(`[Vision] Minecraft window detected: ${x},${y} ${width}x${height}`);
        }
        resolve(cachedWindowRect);
      }
    );
  });
}

export async function captureScreenRegion(x: number, y: number, width: number, height: number): Promise<string | null> {
  try {
    const { default: screenshot } = await import('screenshot-desktop');
    const { default: sharp } = await import('sharp');
    const buffer = await screenshot({ format: 'jpeg' });
    const image = sharp(buffer);
    const meta = await image.metadata();
    const maxWidth = meta.width || width;
    const maxHeight = meta.height || height;

    // Minecraftウィンドウが見つかればその矩形だけをキャプチャ対象にする
    const windowRect = await getMinecraftWindowRect();
    let left = x;
    let top = y;
    let w = width;
    let h = height;

    if (!windowRect && Date.now() - lastFallbackLogTime > FALLBACK_LOG_INTERVAL_MS) {
      lastFallbackLogTime = Date.now();
      console.warn('[Vision] Minecraft window not found. Falling back to full-screen capture.');
    }

    if (windowRect) {
      // スクリーンショット（プライマリモニタ原点(0,0)想定）とウィンドウ矩形の交差領域を計算
      const ix = Math.max(0, windowRect.x);
      const iy = Math.max(0, windowRect.y);
      const ix2 = Math.min(maxWidth, windowRect.x + windowRect.width);
      const iy2 = Math.min(maxHeight, windowRect.y + windowRect.height);
      if (ix2 > ix && iy2 > iy) {
        left = ix;
        top = iy;
        w = ix2 - ix;
        h = iy2 - iy;
      }
      // 交差領域がない（別モニタ上など）場合は引数の領域にフォールバック
    }

    left = Math.max(0, Math.min(Math.floor(left), Math.max(0, maxWidth - 1)));
    top = Math.max(0, Math.min(Math.floor(top), Math.max(0, maxHeight - 1)));
    w = Math.max(1, Math.min(Math.floor(w), maxWidth - left));
    h = Math.max(1, Math.min(Math.floor(h), maxHeight - top));

    const resized = await image
      .extract({ left, top, width: w, height: h })
      .resize(640, 360)
      .jpeg({ quality: 50 })
      .toBuffer();
    return resized.toString('base64');
  } catch (err) {
    console.error('[Vision] Screen capture failed:', err);
    return null;
  }
}
