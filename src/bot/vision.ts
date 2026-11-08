import { createCanvas } from 'canvas';
import * as sharp from 'sharp';

// Capture screen region - for Minecraft window or full screen
export async function captureScreenRegion(x: number, y: number, width: number, height: number): Promise<string> {
  try {
    // Use Minecraft bot's perception or screen capture
    // This is a placeholder - actual implementation depends on the bot framework
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Fill with a pattern to indicate capture
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);
    
    // Return as base64 for now
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  } catch (err) {
    console.error('Screen capture failed:', err);
    return '';
  }
}

// Resize base64 image to target dimensions
export async function resizeBase64Image(base64: string, maxWidth: number, maxHeight: number): Promise<string> {
  try {
    const img = await sharp(Buffer.from(base64, 'base64'))
      .resize({ width: maxWidth, height: maxHeight, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
    
    return img.toString('base64');
  } catch (err) {
    console.error('Image resize failed:', err);
    return base64;
  }
}

// Convert canvas to base64 data URL
export function canvasToBase64(canvas: any): string {
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}