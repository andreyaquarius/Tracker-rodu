import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/features/context-graph/ContextRelationshipGraphV1.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/features/context-graph/ContextRelationshipGraphV1.css", import.meta.url),
  "utf8",
);

test("universal relationship graph accepts a concrete center, bounded nodes and labeled edges", () => {
  assert.match(component, /centerNode:\s*ContextRelationshipGraphNode/u);
  assert.match(component, /nodes:\s*readonly ContextRelationshipGraphNode\[\]/u);
  assert.match(component, /edges:\s*readonly ContextRelationshipGraphEdge\[\]/u);
  assert.match(component, /buildBoundedContextRelationshipGraph\(centerNode, nodes, edges/u);
  assert.match(component, /maxNodes = 120/u);
  assert.match(component, /maxEdges = 320/u);
  assert.match(component, /centerConnectionLabels = "edge"/u);
  assert.match(component, /node\.kind === "group"/u);
  assert.doesNotMatch(component, /<textPath/u);
  assert.match(component, /context-relationship-graph-v1__edge-label-card/u);
  assert.match(component, /presentation\.labelLines\.map[\s\S]*?<tspan/u);
});

test("component exposes independent 2D and true perspective 3D controls", () => {
  assert.match(component, /projectContextRelationshipGraph2D/u);
  assert.match(component, /projectContextRelationshipGraph3D/u);
  assert.match(component, /aria-pressed=\{mode === nextMode\}/u);
  assert.match(component, /startSceneDrag/u);
  assert.match(component, /setPointerCapture/u);
  assert.match(component, /onPointerMove=\{updateSceneDrag\}/u);
  assert.match(component, /mode === "3d" && event\.shiftKey \? "rotate" : "pan"/u);
  assert.match(component, /const canvasRef = useRef<HTMLDivElement \| null>/u);
  assert.match(component, /if \(event\.deltaY === 0\) return;/u);
  assert.match(component, /canvas\.addEventListener\("wheel", handleCanvasWheel, \{ passive: false \}\)/u);
  assert.match(component, /canvas\.removeEventListener\("wheel", handleCanvasWheel\)/u);
  assert.match(component, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/u);
  assert.match(component, /event\.deltaMode === WheelEvent\.DOM_DELTA_LINE/u);
  assert.match(component, /Math\.exp\(-pixelDelta \* 0\.0011\)/u);
  assert.match(component, /ref=\{canvasRef\}/u);
  assert.doesNotMatch(component, /onWheel=/u);
  assert.match(component, /ArrowLeft/u);
  assert.match(component, /ArrowRight/u);
  assert.match(component, /ArrowUp/u);
  assert.match(component, /ArrowDown/u);
  assert.match(component, /event\.key === "Home" \|\| event\.key === "0"/u);
  assert.match(component, /Зменшити масштаб/u);
  assert.match(component, /Збільшити масштаб/u);
  assert.match(component, /Підігнати й скинути/u);
});

test("one compact toolbar leaves the primary area to the canvas", () => {
  assert.match(component, /<header className="context-relationship-graph-v1__toolbar"/u);
  assert.match(component, /context-relationship-graph-v1__title/u);
  assert.match(component, /context-relationship-graph-v1__controls/u);
  assert.match(component, /context-relationship-graph-v1__mode/u);
  assert.match(component, /context-relationship-graph-v1__zoom/u);
  assert.doesNotMatch(component, /context-relationship-graph-v1__header/u);
  assert.match(component, /context-relationship-graph-v1__canvas-help/u);
  assert.match(styles, /\.context-relationship-graph-v1__workspace\s*\{[\s\S]*?min-height:\s*clamp\(34rem, 72vh, 56rem\)/u);
  assert.match(styles, /\.context-relationship-graph-v1__details\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*min\(17rem/u);
});

test("compact fullscreen control uses the native API with a graceful fallback", () => {
  assert.match(component, /const rootRef = useRef<HTMLElement \| null>/u);
  assert.match(component, /document\.addEventListener\("fullscreenchange"/u);
  assert.match(component, /element\.requestFullscreen/u);
  assert.match(component, /document\.exitFullscreen/u);
  assert.match(component, /element\.scrollIntoView/u);
  assert.match(component, /Розгорнути граф на весь екран/u);
  assert.match(component, /Вийти з повноекранного режиму/u);
  assert.match(styles, /\.context-relationship-graph-v1:fullscreen\s*\{[\s\S]*?height:\s*100vh;[\s\S]*?width:\s*100vw/u);
  assert.match(styles, /:fullscreen \.context-relationship-graph-v1__workspace\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0/u);
});

test("fullscreen preserves the only keyboard fallback and mobile selection details", () => {
  assert.doesNotMatch(styles, /:fullscreen \.context-relationship-graph-v1__fallback\s*\{[^}]*display:\s*none/u);
  assert.match(styles, /:fullscreen \.context-relationship-graph-v1__fallback\s*\{[\s\S]*?max-height:\s*45vh/u);
  assert.match(styles, /:fullscreen \.context-relationship-graph-v1__fallback\[open\]\s*\{[\s\S]*?overflow:\s*auto/u);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?:fullscreen \.context-relationship-graph-v1__workspace\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto/u);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?:fullscreen \.context-relationship-graph-v1__details\s*\{[\s\S]*?max-height:\s*min\(32vh, 16rem\);[\s\S]*?overflow:\s*auto/u);
  assert.match(component, /<aside className="context-relationship-graph-v1__details" aria-live="polite">/u);
  assert.match(component, /<details className="context-relationship-graph-v1__fallback">/u);
});

test("nodes and edges are selectable and have a compact detail panel", () => {
  assert.match(component, /selectNode\(node\)/u);
  assert.match(component, /selectEdge\(edge\)/u);
  assert.match(component, /<aside className="context-relationship-graph-v1__details"/u);
  assert.match(component, /Видимих зв’язків/u);
  assert.match(component, /Зв’язок між людьми/u);
  assert.match(component, /Зв’язок між групами прізвищ/u);
  assert.match(component, /Належність особи до групи/u);
  assert.match(component, /Відкрити картку/u);
  assert.match(component, /onActivate && node\.kind === "person" && node\.activatable !== false/u);
  assert.match(component, /onNodeSelect\?\.\(node\)/u);
  assert.match(component, /onEdgeSelect\?\.\(edge\)/u);
});

test("accessible fallback preserves all visible people, groups and relationships", () => {
  assert.match(component, /<details className="context-relationship-graph-v1__fallback">/u);
  assert.match(component, /Текстовий список людей, груп і зв’язків/u);
  assert.match(component, /graph\.nodes\.map/u);
  assert.match(component, /graph\.edges\.map/u);
  assert.match(component, /Люди та групи/u);
  assert.match(component, /Зв’язки/u);
  assert.match(component, /<svg[\s\S]*?aria-hidden="true"[\s\S]*?focusable="false"/u);
  assert.equal(component.match(/tabIndex=\{0\}/gu)?.length, 1, "only the graph canvas belongs in sequential focus order");
  assert.doesNotMatch(component, /activateWithKeyboard/u);
});

test("graph styles are responsive, depth-aware and reduced-motion safe", () => {
  assert.match(styles, /\.context-relationship-graph-v1__canvas\.is-3d[\s\S]*?perspective:\s*900px/u);
  assert.match(styles, /\.context-relationship-graph-v1__canvas\s*\{[\s\S]*?overscroll-behavior:\s*contain/u);
  assert.match(styles, /\.context-relationship-graph-v1__edge-hit[\s\S]*?stroke-width:\s*14[\s\S]*?vector-effect:\s*non-scaling-stroke/u);
  assert.match(styles, /\.context-relationship-graph-v1__edge-label-card rect[\s\S]*?fill-opacity:\s*0\.98[\s\S]*?stroke-width:\s*1\.25/u);
  assert.match(styles, /\.context-relationship-graph-v1__edge-label-card text[\s\S]*?font-size:\s*11\.5px[\s\S]*?text-rendering:\s*geometricPrecision/u);
  assert.match(styles, /\.context-relationship-graph-v1__edge-label-leader[\s\S]*?stroke-dasharray:\s*3 3/u);
  assert.doesNotMatch(styles, /paint-order:\s*stroke/u);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?\.context-relationship-graph-v1__details\s*\{[\s\S]*?position:\s*static/u);
  assert.match(styles, /\.context-relationship-graph-v1__canvas\s*\{[\s\S]*?touch-action:\s*none/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?grid-template-columns:\s*auto auto minmax\(4\.5rem, 1fr\) auto[\s\S]*?min-height:\s*44px/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none !important/u);
});

test("people use readable multiline cards and labels never rotate with an edge", () => {
  assert.match(component, /context-relationship-graph-v1__node-card/u);
  assert.match(component, /presentation\.labelLines\.map[\s\S]*?\$\{node\.id\}-name-/u);
  assert.match(component, /<title>\{node\.label\}<\/title>/u);
  assert.doesNotMatch(component, /<circle/u);
  assert.doesNotMatch(component, /scale\(\$\{node\.scale\}\)/u);
  assert.match(component, /0\.92 \+ \(node\.scale - 1\) \* 0\.55/u);
  assert.match(component, /transform=\{`translate\(\$\{presentation\.labelX\} \$\{presentation\.labelY\}\)`\}/u);
  assert.doesNotMatch(component, /rotate\([^)]*presentation\.label/u);
  assert.match(styles, /\.context-relationship-graph-v1__node-label\s*\{[\s\S]*?font-size:\s*11px[\s\S]*?text-rendering:\s*geometricPrecision/u);
});

test("scene zoom and manual card placement move the intended geometry", () => {
  assert.match(component, /const \[nodeOffsets, setNodeOffsets\]/u);
  assert.match(component, /applyContextRelationshipGraphNodeOffsets\(projected, nodeOffsets\)/u);
  assert.match(component, /className="context-relationship-graph-v1__scene"/u);
  assert.match(component, /transform=\{sceneTransform\}/u);
  assert.match(component, /`scale\(\$\{clampGraphZoom\(view\.zoom\)\}\)`/u);
  assert.match(component, /data-node-id=\{node\.id\}/u);
  assert.match(component, /startNodeDrag\(node\.id, event\)/u);
  assert.match(component, /onPointerMove=\{updateNodeDrag\}/u);
  assert.match(component, /event\.stopPropagation\(\)/u);
  assert.match(component, /setNodeOffsets\(\(current\) =>/u);
  assert.match(component, /setNodeOffsets\(\{\}\)/u);
  assert.match(component, /renderedNodePresentations\.map/u);
  assert.match(component, /onLostPointerCapture=\{finishNodeDrag\}/u);
  assert.match(component, /onLostPointerCapture=\{finishSceneDrag\}/u);
  assert.match(component, /Картку — окремо/u);
  assert.match(component, /тло — весь граф/u);
});

test("technical structure can remain inspectable without repeated canvas labels", () => {
  assert.match(component, /edge\.labelVisibility === "details-only"/u);
  assert.match(component, /visibleEdgeLabelIds\.has\(edge\.id\)/u);
  assert.match(component, /data-edge-id=\{edge\.id\}/u);
  assert.match(component, /edge\.lineStyle === "dashed"/u);
  assert.match(styles, /\.context-relationship-graph-v1__edge\.is-dashed[\s\S]*?stroke-dasharray:\s*6 5/u);
});

test("person cards use compact geometry instead of the former oversized bounds", () => {
  assert.match(component, /const baseWidth = center \? 170 : node\.kind === "group" \? 150 : 158/u);
  assert.match(component, /const baseHeight = center \? 74 : node\.kind === "group" \? 68/u);
  assert.match(component, /center \? 196 : 184/u);
  assert.match(component, /node\.kind === "group" \? 88 : 94/u);
  assert.match(styles, /\.context-relationship-graph-v1__node-card\s*\{[\s\S]*?stroke-width:\s*1\.75/u);
  assert.match(styles, /\.context-relationship-graph-v1__node\.is-center \.context-relationship-graph-v1__node-card\s*\{[\s\S]*?stroke-width:\s*2\.5/u);
});

test("simple person-centred mode keeps roles on cards and every line identifies its endpoints", () => {
  assert.match(component, /centerConnectionLabels === "node"/u);
  assert.match(component, /centerConnectionByNodeId\.get\(node\.id\)\?\.label/u);
  assert.match(component, /data-source-id=\{edge\.sourceId\}/u);
  assert.match(component, /data-target-id=\{edge\.targetId\}/u);
  assert.match(component, /presentation\.leaderPath/u);
  assert.doesNotMatch(component, /const normalDistances = \[62, 94, 126, 158, 190, 222\]/u);
  assert.match(styles, /\.context-relationship-graph-v1__node \.context-relationship-graph-v1__node-kind\.is-role[\s\S]*?font-weight:\s*800/u);
});

test("component adds no graph rendering dependency", () => {
  assert.doesNotMatch(component, /from\s+["'](?:d3|three|cytoscape|react-force-graph|vis-network)/u);
});
