export interface PhotoTagRect { x: number; y: number; width: number; height: number }
export interface PhotoTagPoint { x: number; y: number }
const unit = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Bounding box is the displayed image itself, without letterboxing or rotation. */
export function photoTagPoint(clientX: number, clientY: number,
  box: { left: number; top: number; width: number; height: number }): PhotoTagPoint {
  if (![clientX, clientY, box.left, box.top, box.width, box.height].every(Number.isFinite)
    || box.width <= 0 || box.height <= 0) throw new Error("Зображення ще не завантажено.");
  return { x: unit((clientX - box.left) / box.width), y: unit((clientY - box.top) / box.height) };
}
export function photoTagRect(start: PhotoTagPoint, end: PhotoTagPoint): PhotoTagRect {
  const x = round(unit(Math.min(start.x, end.x)));
  const y = round(unit(Math.min(start.y, end.y)));
  return { x, y, width: round(unit(Math.max(start.x, end.x)) - x), height: round(unit(Math.max(start.y, end.y)) - y) };
}
export function validPhotoTagRect(rect: PhotoTagRect): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0
    && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 + 1e-9 && rect.y + rect.height <= 1 + 1e-9;
}
export function photoTagStyle(rect: PhotoTagRect) {
  return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` };
}

export function canonicalPhotoTagRect(rect: PhotoTagRect): PhotoTagRect {
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}
