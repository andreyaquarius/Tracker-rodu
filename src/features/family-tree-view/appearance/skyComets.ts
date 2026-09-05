export const SKY_ANIMATION_FPS = 30;
export const SKY_COMET_INTERVAL_SECONDS = 20;
export const SKY_COMET_DURATION_SECONDS = 3.6;

/** Stable randomness within one pass; different timings, colors and directions each pass.
 * One bounded opportunity per 20-second window prevents bursts or unbounded particles.
 * Components supply a fresh session seed, so reopening does not repeat a fixed sequence.
 */
export function skyCometFrame(seconds: number, width: number, height: number, seed = 0) {
  if (![seconds, width, height, seed].every(Number.isFinite) || seconds < 0 || width <= 0 || height <= 0) return undefined;
  const pass = Math.floor(seconds / SKY_COMET_INTERVAL_SECONDS);
  const random = (slot: number) => {
    const value = Math.sin((pass * 17 + slot + seed) * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  const startDelay = 3 + random(0) * 7;
  const duration = SKY_COMET_DURATION_SECONDS + random(1) * 1.4;
  const phase = seconds % SKY_COMET_INTERVAL_SECONDS - startDelay;
  if (phase < 0 || phase >= duration) return undefined;
  const t = phase / duration;
  const edge = Math.floor(random(2) * 4);
  const startAlong = 0.08 + random(3) * 0.84;
  const endAlong = 0.08 + random(4) * 0.84;
  const margin = Math.min(160, Math.max(width, height) * 0.16);
  const start = edge === 0 ? { x: -margin, y: height * startAlong }
    : edge === 1 ? { x: width + margin, y: height * startAlong }
    : edge === 2 ? { x: width * startAlong, y: -margin }
    : { x: width * startAlong, y: height + margin };
  const end = edge === 0 ? { x: width + margin, y: height * endAlong }
    : edge === 1 ? { x: -margin, y: height * endAlong }
    : edge === 2 ? { x: width * endAlong, y: height + margin }
    : { x: width * endAlong, y: -margin };
  const dx = end.x - start.x; const dy = end.y - start.y;
  return {
    x: start.x + dx * t, y: start.y + dy * t,
    angle: Math.atan2(dy, dx),
    opacity: Math.sin(Math.PI * t) * 0.82,
    tail: Math.min(130, Math.max(48, width * (0.07 + random(5) * 0.06))),
    color: ["#a8deff", "#ffd5a0", "#cfbaff", "#a0f0d5"][Math.floor(random(6) * 4)]!,
  };
}
