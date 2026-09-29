type CropRect = { x: number; y: number; width: number; height: number };
type TextBoxGeometry = { x: number; y: number; width: number; height: number; fontSize: number };

/** Remap percentage-based text boxes into the retained region of an image. */
export function cropTextBoxes<T extends TextBoxGeometry>(boxes: T[], crop: CropRect): T[] {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) {
    throw new Error('裁剪区域必须具有有效的宽度和高度。');
  }
  const left = crop.x * 100;
  const top = crop.y * 100;
  const right = (crop.x + crop.width) * 100;
  const bottom = (crop.y + crop.height) * 100;
  return boxes.flatMap((box) => {
    const visibleLeft = Math.max(box.x, left);
    const visibleTop = Math.max(box.y, top);
    const visibleRight = Math.min(box.x + box.width, right);
    const visibleBottom = Math.min(box.y + box.height, bottom);
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return [];
    return [{
      ...box,
      x: (visibleLeft - left) / crop.width,
      y: (visibleTop - top) / crop.height,
      width: (visibleRight - visibleLeft) / crop.width,
      height: (visibleBottom - visibleTop) / crop.height,
      fontSize: Math.max(8, Math.min(96, box.fontSize / crop.width))
    }];
  });
}
