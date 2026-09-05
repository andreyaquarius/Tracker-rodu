import type { ConstellationTour, ConstellationTourStep } from "./constellationCinema.ts";

export function ConstellationPresentationControls({ tour, index, step, manual, playing, seconds, reducedMotion, starsMoving, exporting, message,
  onPlay, onPrevious, onNext, onSpeed, onStars, onExport, onExit }: {
  tour: ConstellationTour; index: number; step?: ConstellationTourStep; manual: boolean; playing: boolean; seconds: number; reducedMotion: boolean;
  starsMoving: boolean; exporting: boolean; message: string; onPlay: () => void; onPrevious: () => void; onNext: () => void;
  onSpeed: (seconds: number) => void; onStars: () => void; onExport: () => void; onExit: () => void;
}) {
  return <section className="constellation-presentation-panel" aria-label="Керування презентацією">
    <div className="constellation-presentation-story" aria-live={playing ? "off" : "polite"}>
      <span className="constellation-eyebrow">{manual ? "РУЧНИЙ ПЕРЕГЛЯД · ПОКАЗ НА ПАУЗІ" : `ПОДОРОЖ РОДОМ · ${index + 1} / ${tour.steps.length}${tour.total > tour.steps.length ? ` · добірка з ${tour.total}` : ""}`}</span>
      <h3>{step?.title}</h3><p>{step?.detail}</p>
    </div>
    <div className="constellation-presentation-buttons">
      <button type="button" aria-label="Попередній кадр" disabled={index <= 0} onClick={onPrevious}>←</button>
      <button type="button" className="constellation-primary" onClick={onPlay}>{playing ? "Ⅱ Пауза" : index === tour.steps.length - 1 ? "↻ Повторити" : "▶ Відтворити"}</button>
      <button type="button" aria-label="Наступний кадр" disabled={index >= tour.steps.length - 1} onClick={onNext}>→</button>
      <label className="constellation-presentation-speed">Темп<select aria-label="Тривалість кадру" value={seconds} onChange={event => onSpeed(Number(event.target.value))}>
        <option value={4}>4 с</option><option value={7}>7 с</option><option value={12}>12 с</option>
      </select></label>
      <button type="button" onClick={onStars} disabled={reducedMotion} aria-pressed={starsMoving}>{starsMoving ? "Зупинити зорі" : "Рух зірок"}</button>
      <button type="button" onClick={onExport} disabled={exporting}>{exporting ? "Зберігаємо…" : "Кадр PNG"}</button>
      <button type="button" className="constellation-presentation-exit" onClick={onExit}>Завершити показ</button>
    </div>
    <p className="constellation-presentation-hint">{message || (reducedMotion ? "Зменшення руху ввімкнено в системі: зорі нерухомі, переходи без анімації." : "Пробіл — пауза · ← / → — кадри · Esc — завершити. Ручне керування мапою зупиняє автопоказ.")}</p>
  </section>;
}
