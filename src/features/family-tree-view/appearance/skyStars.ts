/** Screen-space stars: radius and speed are CSS pixels, never graph/world units. */
export interface SkyStar { x: number; y: number; radius: number; speed: number; alpha: number; tint: number }
export function skyStars(width: number, height: number): SkyStar[] {
  const count = Math.max(45, Math.min(220, Math.round(width * height / 5500)));
  const random = (index: number) => { const value = Math.sin(index * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
  return Array.from({ length: count }, (_, index) => ({ x: random(index * 6), y: random(index * 6 + 1), radius: 0.55 + random(index * 6 + 2) * 1.3,
    speed: 1.4 + random(index * 6 + 3) * 4.6, alpha: 0.28 + random(index * 6 + 4) * 0.6, tint: index % 4 }));
}
export function skyStarPoint(star: SkyStar, seconds: number, width: number, height: number) {
  const wrap = (value: number, limit: number) => ((value % limit) + limit) % limit;
  return { x: wrap(star.x * (width + 40) + seconds * star.speed, width + 40) - 20,
    y: wrap(star.y * (height + 40) - seconds * star.speed * 0.23, height + 40) - 20 };
}
