type PdfTextBox = {
  text: string; x: number; y: number; width: number; height: number;
  fontSize: number; color: string; bold: boolean; align: 'left' | 'center' | 'right';
};

/** Wrap both space-delimited text and Chinese/Japanese lines with no spaces. */
export function wrapCanvasText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.match(/\S+\s*|\s+/g) ?? []) {
      if (ctx.measureText(line + word).width <= width) { line += word; continue; }
      if (line) { lines.push(line.trimEnd()); line = ''; }
      if (ctx.measureText(word).width <= width) { line = word.trimStart(); continue; }
      // Array.from iterates Unicode code points, keeping surrogate pairs intact.
      for (const character of Array.from(word)) {
        if (line && ctx.measureText(line + character).width > width) {
          lines.push(line.trimEnd());
          line = '';
        }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Paint using the browser's CJK-capable fonts, so PDF does not depend on Helvetica glyphs. */
export function paintPdfTextBoxes(ctx: CanvasRenderingContext2D, imageWidth: number, imageHeight: number, boxes: PdfTextBox[]): void {
  for (const box of boxes) {
    if (!box.text || box.width <= 0 || box.height <= 0) continue;
    const x = box.x / 100 * imageWidth;
    const y = box.y / 100 * imageHeight;
    const width = box.width / 100 * imageWidth;
    const height = box.height / 100 * imageHeight;
    const fontSize = Math.max(8, box.fontSize) * imageWidth / 960;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.font = `${box.bold ? '700' : '400'} ${fontSize}px Arial, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(box.color) ? box.color : '#111827';
    ctx.textBaseline = 'top';
    ctx.textAlign = box.align;
    const anchorX = box.align === 'center' ? x + width / 2 : box.align === 'right' ? x + width : x;
    const lineHeight = fontSize * 1.18;
    wrapCanvasText(ctx, box.text, width).forEach((line, index) => {
      if (index * lineHeight < height) ctx.fillText(line, anchorX, y + index * lineHeight);
    });
    ctx.restore();
  }
}
