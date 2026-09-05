import type { FamilyTreeChartColorScheme } from "../appearance/familyTreeChartColorScheme.ts";

/** Local PNG snapshot of the current visible viewport, not the entire tree or a video. */
export async function exportConstellationFrame(viewport: HTMLElement, colors: FamilyTreeChartColorScheme, heading: string, detail: string): Promise<void> {
  const rect = viewport.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) throw new Error("Спочатку відкрийте діаграму.");
  const scale = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(rect.width, rect.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(rect.width * scale); canvas.height = Math.round((rect.height + 90) * scale);
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Браузер не підтримує збереження кадру.");
  ctx.scale(scale, scale); ctx.fillStyle = colors.background; ctx.fillRect(0, 0, rect.width, rect.height + 90);
  for (const source of viewport.querySelectorAll<HTMLCanvasElement>("canvas")) if (source.width && source.height) ctx.drawImage(source, 0, 0, rect.width, rect.height);
  const write = (text: string, x: number, y: number, width: number, font: string, color: string, maxLines = 2, lineHeight = 17, centered = false) => {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = centered ? "center" : "left"; ctx.textBaseline = "top";
    const words = text.trim().split(/\s+/u); const lines: string[] = []; let line = "";
    for (const word of words) {
      if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    lines.slice(0, maxLines).forEach((value, index) => ctx.fillText(value + (index === maxLines - 1 && lines.length > maxLines ? "…" : ""), centered ? x + width / 2 : x, y + index * lineHeight, width));
  };
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, rect.width, rect.height); ctx.clip();
  for (const label of viewport.querySelectorAll<HTMLButtonElement>(".constellation-person-label")) {
    const box = label.getBoundingClientRect(); const style = getComputedStyle(label);
    const left = box.left - rect.left; const top = box.top - rect.top;
    ctx.fillStyle = style.backgroundColor; ctx.beginPath(); ctx.roundRect(left, top, box.width, box.height, 8); ctx.fill();
    ctx.strokeStyle = label.getAttribute("aria-pressed") === "true" ? style.getPropertyValue("--constellation-person-stroke") || colors.focus.stroke : style.borderColor;
    ctx.lineWidth = 1; ctx.stroke();
    const title = label.querySelector("strong"); const subtitle = label.querySelector("small");
    if (title) {
      const textBox = title.getBoundingClientRect(); const textStyle = getComputedStyle(title);
      write(title.textContent ?? "", textBox.left - rect.left, textBox.top - rect.top, textBox.width, textStyle.font, colors.text, 2, Number.parseFloat(textStyle.lineHeight) || 15, true);
    }
    if (subtitle) {
      const textBox = subtitle.getBoundingClientRect();
      write(subtitle.textContent ?? "", textBox.left - rect.left, textBox.top - rect.top, textBox.width, getComputedStyle(subtitle).font, colors.mutedText, 1, 12, true);
    }
  }
  ctx.restore();
  const brand = viewport.querySelector<HTMLImageElement>(".constellation-brand img");
  if (brand?.complete && brand.naturalWidth && new URL(brand.src, location.href).origin === location.origin) ctx.drawImage(brand, 14, rect.height + 20, 36, 36);
  write("Трекер Роду · Сузір’я роду", 60, rect.height + 14, rect.width - 74, "600 14px system-ui", colors.text, 1);
  write(heading, 60, rect.height + 39, rect.width - 74, "600 12px system-ui", colors.text, 1);
  write(detail, 14, rect.height + 61, rect.width - 28, "10px system-ui", colors.mutedText, 1);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Не вдалося створити PNG.")), "image/png"));
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = "Трекер-Роду-Сузірʼя.png"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
