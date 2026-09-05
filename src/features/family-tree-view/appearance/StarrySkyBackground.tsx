import { memo, useEffect, useId, useRef, useState } from "react";
import { useSkyMotionEnvironment } from "./useSkyMotionEnvironment.ts";
import { SKY_ANIMATION_FPS, skyCometFrame } from "./skyComets.ts";

// A decorative sky, not astronomical or genealogical data. Fixed complexity,
// independent of people count and zoom. Motion changes two decorative groups,
// never React state, individual stars, layout coordinates or the genealogy graph.
const random = (index: number) => {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
};
const stars = Array.from({ length: 160 }, (_, i) => ({
  x: random(i * 4) * 1200, y: random(i * 4 + 1) * 800,
  r: 0.5 + random(i * 4 + 2) * 1.15, opacity: 0.24 + random(i * 4 + 3) * 0.55,
  color: ["#d5e8ff", "#8fafff", "#b8a3ff", "#6ee6dc"][i % 4],
}));

/** Nested SVG works both behind HTML cards and inside exportable chart SVGs. */
export const StarrySkyBackground = memo(function StarrySkyBackground({
  x = 0, y = 0, width = "100%", height = "100%", className, moving = true,
}: { x?: number; y?: number; width?: number | string; height?: number | string; className?: string; moving?: boolean }) {
  const id = `tree-sky-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const starsRef = useRef<SVGGElement>(null);
  const cometRef = useRef<SVGGElement>(null);
  const elapsed = useRef(0);
  const [cometSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const environment = useSkyMotionEnvironment();
  const active = moving && environment.visible && !environment.reducedMotion;
  useEffect(() => {
    const stars = starsRef.current; const comet = cometRef.current;
    if (!stars || !comet) return;
    comet.setAttribute("opacity", "0");
    if (!active) return;
    let frame = 0; let last = performance.now(); let drawn = last;
    const tick = (now: number) => {
      if (document.hidden) return;
      elapsed.current += Math.min(100, now - last) / 1000; last = now;
      if (now - drawn >= 1000 / SKY_ANIMATION_FPS) {
        drawn = now;
        stars.setAttribute("transform", `translate(${Math.sin(elapsed.current / 60) * 26} ${Math.sin(elapsed.current / 100) * 16})`);
        const point = skyCometFrame(elapsed.current, 1200, 800, cometSeed);
        comet.setAttribute("opacity", String(point?.opacity ?? 0));
        if (point) {
          comet.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${point.angle * 180 / Math.PI})`);
          comet.style.setProperty("--comet-color", point.color);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, cometSeed]);
  return (
    <svg data-starry-sky="true" data-moving={active} className={className} x={x} y={y} width={width} height={height}
      viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false" pointerEvents="none">
      <defs>
        <radialGradient id={`${id}-mist`}>
          <stop stopColor="#354c9a" stopOpacity=".29" />
          <stop offset="1" stopColor="#354c9a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-teal`}>
          <stop stopColor="#177f85" stopOpacity=".15" />
          <stop offset="1" stopColor="#177f85" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1200" height="800" fill="#050814" />
      <ellipse cx="830" cy="160" rx="600" ry="390" fill={`url(#${id}-mist)`} />
      <ellipse cx="250" cy="710" rx="620" ry="340" fill={`url(#${id}-teal)`} />
      <g ref={starsRef}>{stars.map((star, i) => <g key={i} fill={star.color} opacity={star.opacity}>
        {i % 13 === 0 ? <circle cx={star.x} cy={star.y} r={star.r * 4} opacity=".12" /> : null}
        <circle cx={star.x} cy={star.y} r={star.r} />
      </g>)}</g>
      <g ref={cometRef} data-sky-comet="true" opacity="0">
        <defs>
          <linearGradient id={`${id}-tail`} x1="0" x2="1">
            <stop stopColor="var(--comet-color, #a8deff)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--comet-color, #a8deff)" stopOpacity=".9" />
          </linearGradient>
        </defs>
        <path d="M -130 -1 Q -36 -4 0 0 Q -36 4 -130 1 Z" fill={`url(#${id}-tail)`} />
        <circle r="8" fill="var(--comet-color, #a8deff)" opacity=".1" />
        <circle r="4" fill="var(--comet-color, #a8deff)" opacity=".4" />
        <circle r="1.6" fill="#f5faff" />
      </g>
    </svg>
  );
});
