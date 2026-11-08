import screenshot from 'screenshot-desktop';
import sharp from 'sharp';

export async function captureScreenRegion(x: number, y: number, width: number, height: number): Promise<string> {
  try {
    const imgBuffer = await screenshot({ format: 'png' });
    const resized = await sharp(imgBuffer)
      .extract({ left: x, top: y, width, height })
      .jpeg({ quality: 70 })
      .toBuffer();
    return resized.toString('base64');
  } catch (err) {
    console.error('[Vision] Screen capture failed:', err);
    throw err;
  }
}

export async function resizeBase64Image(base64: string, maxWidth: number, maxHeight: number): Promise<string> {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const resized = await sharp(buffer)
      .resize(maxWidth, maxHeight, { fit: 'inside' })
      .jpeg({ quality: 70 })
      .toBuffer();
    return resized.toString('base64');
  } catch (err) {
    console.error('[Vision] Image resize failed:', err);
    throw err;
  }
}