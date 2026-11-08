import screenshot from 'screenshot-desktop';
import sharp from 'sharp';

// 画面の指定領域をキャプチャし、640x360にリサイズしてBase64形式で返す
export async function captureScreenRegion(x: number, y: number, width: number, height: number): Promise<string> {
  try {
    const buffer = await screenshot({ format: 'jpeg' });
    const resized = await sharp(buffer)
      .extract({ left: x, top: y, width, height })
      .resize(640, 360)
      .jpeg({ quality: 50 })
      .toBuffer();
    return resized.toString('base64');
  } catch (err) {
    console.error('[Vision] Screen capture failed:', err);
    throw err;
  }
}
