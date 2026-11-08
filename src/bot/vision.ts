// 画面の指定領域をキャプチャし、640x360にリサイズしてBase64形式で返す
// screenshot-desktop / sharp が利用できない環境でもアプリ起動を妨げないよう、
// 依存モジュールは必要になった時点で動的に読み込み、失敗時は null を返す。
export async function captureScreenRegion(x: number, y: number, width: number, height: number): Promise<string | null> {
  try {
    const { default: screenshot } = await import('screenshot-desktop');
    const { default: sharp } = await import('sharp');
    const buffer = await screenshot({ format: 'jpeg' });
    const image = sharp(buffer);
    const meta = await image.metadata();
    const maxWidth = meta.width || width;
    const maxHeight = meta.height || height;
    const left = Math.max(0, Math.min(Math.floor(x), Math.max(0, maxWidth - 1)));
    const top = Math.max(0, Math.min(Math.floor(y), Math.max(0, maxHeight - 1)));
    const w = Math.max(1, Math.min(Math.floor(width), maxWidth - left));
    const h = Math.max(1, Math.min(Math.floor(height), maxHeight - top));
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
