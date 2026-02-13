const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');

function collectBounds(node, bounds) {
  if (!node || !node.rect) return;

  const w = node.rect.width || 0;
  const h = node.rect.height || 0;
  if (w <= 0 || h <= 0) return;

  const x = node.rect.x || 0;
  const y = node.rect.y || 0;
  const rotation = node.rotation || 0;

  if (!rotation) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x + w);
    bounds.maxY = Math.max(bounds.maxY, y + h);
  } else {
    const rad = (rotation * Math.PI) / 180;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const corners = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
    for (const c of corners) {
      const dx = c.x - cx;
      const dy = c.y - cy;
      const rx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
      const ry = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
      bounds.minX = Math.min(bounds.minX, rx);
      bounds.minY = Math.min(bounds.minY, ry);
      bounds.maxX = Math.max(bounds.maxX, rx);
      bounds.maxY = Math.max(bounds.maxY, ry);
    }
  }

  const children = node.children || [];
  for (const child of children) {
    collectBounds(child, bounds);
  }
}

function collectImagePaths(node, set) {
  if (!node) return;
  if (node.imagePath) set.add(node.imagePath);
  const children = node.children || [];
  for (const child of children) collectImagePaths(child, set);
}

async function main() {
  const layoutPath = path.resolve(process.argv[2] || path.join('output', 'layout.json'));
  const outputPng = path.resolve(process.argv[3] || path.join('output', 'preview.png'));
  const scaleArg = process.argv.find((arg) => arg.startsWith('--scale='));
  const scale = scaleArg ? Math.max(1, parseFloat(scaleArg.split('=')[1]) || 1) : 1;

  const exists = await fs.pathExists(layoutPath);
  if (!exists) {
    console.error(`layout.json not found: ${layoutPath}`);
    process.exit(1);
  }

  const layout = await fs.readJson(layoutPath);
  const outputDir = path.dirname(layoutPath);
  const imagesDir = path.join(outputDir, 'images');
  const bgPath = path.join(imagesDir, 'bg.png');

  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  collectBounds(layout, bounds);

  if (!Number.isFinite(bounds.minX)) {
    console.error('No drawable nodes found in layout.json.');
    process.exit(1);
  }

  const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
  const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
  const offsetX = bounds.minX;
  const offsetY = bounds.minY;

  const imagePaths = new Set();
  collectImagePaths(layout, imagePaths);
  if (await fs.pathExists(bgPath)) {
    imagePaths.add('images/bg.png');
  }

  const imageData = {};
  for (const relPath of imagePaths) {
    const absPath = path.join(outputDir, relPath);
    if (!(await fs.pathExists(absPath))) continue;
    const buffer = await fs.readFile(absPath);
    const base64 = buffer.toString('base64');
    imageData[relPath] = `data:image/png;base64,${base64}`;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          canvas { display: block; }
        </style>
      </head>
      <body>
        <canvas id="canvas"></canvas>
      </body>
    </html>
  `;

  await page.setContent(html, { waitUntil: 'load' });

  await page.evaluate(
    async ({ layoutData, imageDataMap, canvasWidth, canvasHeight, offsetX, offsetY, scaleFactor }) => {
      const canvas = document.getElementById('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      const hiCanvas = document.createElement('canvas');
      hiCanvas.width = Math.ceil(canvasWidth * scaleFactor);
      hiCanvas.height = Math.ceil(canvasHeight * scaleFactor);
      const hiCtx = hiCanvas.getContext('2d');
      hiCtx.imageSmoothingEnabled = true;
      hiCtx.imageSmoothingQuality = 'high';
      hiCtx.clearRect(0, 0, hiCanvas.width, hiCanvas.height);
      hiCtx.scale(scaleFactor, scaleFactor);

      const imageCache = new Map();
      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          if (imageCache.has(src)) {
            resolve(imageCache.get(src));
            return;
          }
          const img = new Image();
          img.onload = () => {
            imageCache.set(src, img);
            resolve(img);
          };
          img.onerror = reject;
          img.src = src;
        });

      const wrapText = (text, maxWidth) => {
        if (!text) return [];
        const hasSpaces = /\\s/.test(text);
        if (!hasSpaces) {
          const lines = [];
          let current = '';
          for (const ch of text) {
            const test = current + ch;
            if (ctx.measureText(test).width > maxWidth && current) {
              lines.push(current);
              current = ch;
            } else {
              current = test;
            }
          }
          if (current) lines.push(current);
          return lines;
        }
        const words = text.split(/\\s+/);
        const lines = [];
        let line = '';
        for (const word of words) {
          const test = line ? `${line} ${word}` : word;
          if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = word;
          } else {
            line = test;
          }
        }
        if (line) lines.push(line);
        return lines;
      };

      const drawImageNode = async (node) => {
        const src = imageDataMap[node.imagePath];
        if (!src) return;
        const img = await loadImage(src);
        const w = node.rect.width;
        const h = node.rect.height;

        hiCtx.drawImage(img, 0, 0, w, h);
      };

      const drawTextNode = (node) => {
        const w = node.rect.width;
        const h = node.rect.height;
        const style = node.style || {};
        const fontSize = style.fontSize || '16px';
        const fontFamily = style.fontFamily || 'sans-serif';
        const fontWeight = style.fontWeight || 'normal';
        const fontStyle = style.fontStyle || 'normal';
        const letterSpacing = style.letterSpacing || 'normal';
        const wordSpacing = style.wordSpacing || 'normal';
        const textTransform = style.textTransform || 'none';
        const textDecoration = style.textDecoration || 'none';
        const textShadow = style.textShadow || 'none';
        const whiteSpace = style.whiteSpace || 'normal';
        const wordBreak = style.wordBreak || 'normal';
        const textIndent = style.textIndent || '0px';
        const direction = style.direction || 'ltr';
        const color = style.color || '#000';
        const align = style.alignment || 'left';
        const sizeNum = parseFloat(fontSize) || 16;
        const lineHeight = style.lineHeight && style.lineHeight !== 'normal'
          ? parseFloat(style.lineHeight) || sizeNum * 1.2
          : sizeNum * 1.2;

        hiCtx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
        hiCtx.fillStyle = color;
        hiCtx.textBaseline = 'top';
        hiCtx.textAlign = align === 'center' || align === 'right' ? align : 'left';
        hiCtx.letterSpacing = letterSpacing;
        hiCtx.wordSpacing = wordSpacing;
        hiCtx.textTransform = textTransform;
        hiCtx.textDecoration = textDecoration;
        hiCtx.textShadow = textShadow;
        hiCtx.whiteSpace = whiteSpace;
        hiCtx.wordBreak = wordBreak;
        hiCtx.textIndent = textIndent;
        hiCtx.direction = direction;

        let textContent = node.text || '';
        if (textTransform === 'uppercase') textContent = textContent.toUpperCase();
        if (textTransform === 'lowercase') textContent = textContent.toLowerCase();
        if (textTransform === 'capitalize') {
          textContent = textContent.replace(/\\b\\w/g, (c) => c.toUpperCase());
        }

        const lines = wrapText(textContent, w);
        let drawY = 0;
        for (const line of lines) {
          if (drawY + lineHeight > h) break;
          let drawX = 0;
          if (hiCtx.textAlign === 'center') drawX = w / 2;
          if (hiCtx.textAlign === 'right') drawX = w;
          hiCtx.fillText(line, drawX, drawY);
          drawY += lineHeight;
        }
      };

      const drawNode = async (node, parentRect, isRoot = false) => {
        if (!node) return;
        const localX = node.rect.x - (parentRect ? parentRect.x : offsetX);
        const localY = node.rect.y - (parentRect ? parentRect.y : offsetY);

        hiCtx.save();
        hiCtx.translate(localX, localY);
        if (node.rotation) {
          const rad = (node.rotation * Math.PI) / 180;
          const cx = node.rect.width / 2;
          const cy = node.rect.height / 2;
          hiCtx.translate(cx, cy);
          hiCtx.rotate(rad);
          hiCtx.translate(-cx, -cy);
        }

        if (node.imagePath) {
          await drawImageNode(node);
        }
        if (node.type === 'Text') {
          // Text nodes are intentionally skipped during preview reconstruction.
        }
        const children = (node.children || []).slice().reverse();
        for (const child of children) {
          await drawNode(child, node.rect);
        }
        hiCtx.restore();
      };

      if (imageDataMap['images/bg.png']) {
        hiCtx.save();
        hiCtx.translate(0, 0);
        await drawImageNode({
          imagePath: 'images/bg.png',
          rect: { x: offsetX, y: offsetY, width: canvasWidth, height: canvasHeight },
          rotation: 0,
        });
        hiCtx.restore();
      }

      await drawNode(layoutData, null, true);

      ctx.drawImage(hiCanvas, 0, 0, canvasWidth, canvasHeight);
    },
    {
      layoutData: layout,
      imageDataMap: imageData,
      canvasWidth: width,
      canvasHeight: height,
      offsetX,
      offsetY,
      scaleFactor: scale,
    }
  );

  await page.screenshot({
    path: outputPng,
    omitBackground: true,
  });

  await browser.close();
  console.log(`Preview saved to ${outputPng}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
