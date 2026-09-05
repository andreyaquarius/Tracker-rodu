import { useEffect, useRef, useState } from "react";
import { skyStarPoint, skyStars } from "../../features/family-tree-view/appearance/skyStars.ts";
import { SKY_ANIMATION_FPS, skyCometFrame } from "../../features/family-tree-view/appearance/skyComets.ts";
import { useSkyMotionEnvironment } from "../../features/family-tree-view/appearance/useSkyMotionEnvironment.ts";
import "./starrySkyCanvas.css";

/** Decorative sky in its own canvas; the graph and React do not redraw on star frames. */
export function StarrySkyCanvas({ width, height, theme = "night", enabled = true, moving = true, className = "" }: {
  width: number; height: number; theme?: "night" | "light"; enabled?: boolean; moving?: boolean; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null); const elapsed = useRef(0);
  const [cometSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const environment = useSkyMotionEnvironment();
  const animate = moving && environment.visible && !environment.reducedMotion;
  useEffect(() => {
    const canvas = ref.current; if (!canvas || width <= 1 || height <= 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(3_000_000 / (width * height)));
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const stars = skyStars(width, height);
    const tints = ["#d5e8ff", "#8fafff", "#b8a3ff", "#6ee6dc"];
    const glows = tints.map(tint => {
      const sprite = document.createElement("canvas"); sprite.width = 32; sprite.height = 32;
      const glow = sprite.getContext("2d")!;
      const gradient = glow.createRadialGradient(16, 16, 0, 16, 16, 16);
      gradient.addColorStop(0, tint + "90"); gradient.addColorStop(0.18, tint + "40"); gradient.addColorStop(1, tint + "00");
      glow.fillStyle = gradient; glow.fillRect(0, 0, 32, 32); return sprite;
    });
    // Prepaint the nebula once. No remote image, shader, GPU requirement or flashing.
    const sky = document.createElement("canvas"); sky.width = canvas.width; sky.height = canvas.height;
    const background = sky.getContext("2d"); if (!background) return;
    background.scale(dpr, dpr); background.fillStyle = theme === "night" ? "#050814" : "#f2f6ff";
    background.fillRect(0, 0, width, height);
    if (enabled) for (const [x, y, radius, color] of [[0.18, 0.18, 0.75, "#4b31a1"], [0.85, 0.72, 0.6, "#0e757e"], [0.68, 0.13, 0.45, "#253e96"]] as const) {
      const gradient = background.createRadialGradient(width * x, height * y, 0, width * x, height * y, Math.max(width, height) * radius);
      gradient.addColorStop(0, color + (theme === "night" ? "45" : "16")); gradient.addColorStop(1, color + "00");
      background.fillStyle = gradient; background.fillRect(0, 0, width, height);
    }
    const paint = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(sky, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!enabled) return;
      for (const star of stars) {
        const point = skyStarPoint(star, elapsed.current, width, height);
        ctx.fillStyle = theme === "night" ? tints[star.tint]! : "#647aa5";
        ctx.globalAlpha = star.alpha * (theme === "night" ? 1 : 0.38);
        if (star.radius > 1.5) {
          ctx.drawImage(glows[star.tint]!, point.x - 7, point.y - 7, 14, 14);
        }
        ctx.beginPath(); ctx.arc(point.x, point.y, star.radius, 0, Math.PI * 2); ctx.fill();
      }
      const comet = animate ? skyCometFrame(elapsed.current, width, height, cometSeed) : undefined;
      if (comet) {
        ctx.save(); ctx.translate(comet.x, comet.y); ctx.rotate(comet.angle);
        ctx.globalAlpha = comet.opacity * (theme === "night" ? 1 : 0.45);
        const tail = ctx.createLinearGradient(-comet.tail, 0, 0, 0);
        tail.addColorStop(0, comet.color + "00"); tail.addColorStop(1, comet.color);
        ctx.fillStyle = tail; ctx.beginPath(); ctx.moveTo(-comet.tail, -0.5);
        ctx.quadraticCurveTo(-comet.tail * 0.25, -3, 0, 0);
        ctx.quadraticCurveTo(-comet.tail * 0.25, 3, -comet.tail, 0.5); ctx.fill();
        ctx.drawImage(glows[0]!, -9, -9, 18, 18);
        ctx.fillStyle = "#f5faff"; ctx.beginPath(); ctx.arc(0, 0, 1.7, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    };
    paint(); let frame = 0; let last = performance.now(); let drawn = last;
    const tick = (now: number) => {
      if (document.hidden) { frame = 0; return; }
      elapsed.current += Math.min(100, now - last) / 1000; last = now;
      if (now - drawn >= 1000 / SKY_ANIMATION_FPS) { paint(); drawn = now; }
      frame = requestAnimationFrame(tick);
    };
    if (enabled && animate) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [width, height, enabled, animate, theme, cometSeed]);
  return <canvas ref={ref} className={`starry-sky-canvas ${className}`} aria-hidden="true" data-starry-sky="canvas" data-moving={enabled && animate} />;
}
