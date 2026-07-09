import Phaser from 'phaser';

/** CC0 procedural placeholder textures (replaced by LimeZu art from curia-deploy at build). */

function fillRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawPixelBorder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, 1);
  ctx.fillRect(0, h - 1, w, 1);
  ctx.fillRect(0, 0, 1, h);
  ctx.fillRect(w - 1, 0, 1, h);
}

function createCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [canvas, ctx];
}

export function registerPlaceholderTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists('office-floor')) return;

  {
    const [canvas, ctx] = createCanvas(32, 32);
    fillRect(ctx, 0, 0, 32, 32, '#3a4a32');
    fillRect(ctx, 2, 2, 28, 28, '#4a5a3a');
    drawPixelBorder(ctx, 32, 32, '#2a3224');
    scene.textures.addCanvas('office-floor', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(48, 32);
    fillRect(ctx, 0, 0, 48, 32, '#5a4632');
    fillRect(ctx, 4, 8, 40, 20, '#6b5538');
    fillRect(ctx, 20, 4, 8, 6, '#7a6548');
    drawPixelBorder(ctx, 48, 32, '#3d3020');
    scene.textures.addCanvas('desk', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(64, 48);
    fillRect(ctx, 0, 0, 64, 48, '#5a4632');
    fillRect(ctx, 6, 10, 52, 28, '#7a6548');
    fillRect(ctx, 24, 4, 16, 8, '#8a7558');
    drawPixelBorder(ctx, 64, 48, '#3d3020');
    scene.textures.addCanvas('desk-boss', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(16, 24);
    fillRect(ctx, 4, 8, 8, 10, '#f5d0a9');
    fillRect(ctx, 5, 2, 6, 6, '#2c1810');
    fillRect(ctx, 3, 14, 10, 8, '#3d5a80');
    fillRect(ctx, 6, 0, 4, 2, '#ffd166');
    scene.textures.addCanvas('character', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(24, 16);
    fillRect(ctx, 0, 6, 24, 4, '#6a6a72');
    fillRect(ctx, 4, 2, 16, 8, '#8a8a92');
    fillRect(ctx, 10, 0, 4, 4, '#c0392b');
    scene.textures.addCanvas('claw', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(48, 40);
    fillRect(ctx, 8, 8, 32, 28, '#5a4a3a');
    fillRect(ctx, 16, 12, 16, 16, '#e8e0d0');
    fillRect(ctx, 20, 16, 8, 8, '#c0392b');
    scene.textures.addCanvas('scheduler', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(24, 32);
    fillRect(ctx, 4, 8, 16, 20, '#6a5a4a');
    fillRect(ctx, 8, 0, 8, 10, '#8a7a6a');
    scene.textures.addCanvas('tube', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(24, 24);
    fillRect(ctx, 6, 4, 12, 16, '#4a4a52');
    fillRect(ctx, 4, 18, 16, 4, '#3a3a42');
    scene.textures.addCanvas('wastebasket', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(32, 16);
    fillRect(ctx, 0, 0, 32, 16, '#f5e6a8');
    drawPixelBorder(ctx, 32, 16, '#c8b878');
    scene.textures.addCanvas('task-card', canvas);
  }

  {
    const [canvas, ctx] = createCanvas(48, 16);
    fillRect(ctx, 0, 0, 48, 16, '#ffd166');
    drawPixelBorder(ctx, 48, 16, '#c9a026');
    scene.textures.addCanvas('badge', canvas);
  }
}

export function tintKey(base: string, color: number): string {
  return `${base}-${color.toString(16)}`;
}

export function ensureTintedTexture(
  scene: Phaser.Scene,
  baseKey: string,
  color: number,
): string {
  const key = tintKey(baseKey, color);
  if (scene.textures.exists(key)) return key;
  const source = scene.textures.get(baseKey);
  const srcImage = source.getSourceImage() as HTMLCanvasElement;
  const [canvas, ctx] = createCanvas(srcImage.width, srcImage.height);
  ctx.drawImage(srcImage, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  scene.textures.addCanvas(key, canvas);
  return key;
}
