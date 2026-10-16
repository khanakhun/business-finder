// WCAG 2.x contrast (BF-033): relative luminance, contrast ratio, and the nearest colour that passes (for actionable
// issues). https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = (rgb: readonly [number, number, number]) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colour closest to `color` (same hue, mixed toward black or white, whichever reaches the ratio sooner) that has
 * at least `ratio` against every colour of `against`; null if neither direction can.
 */
export function suggestColor(
  color: string,
  against: string | readonly string[],
  ratio: number,
): string | null {
  const backgrounds = typeof against === 'string' ? [against] : against;
  const passes = (candidate: string) => backgrounds.every((bg) => contrastRatio(candidate, bg) >= ratio);
  if (passes(color)) return color;
  const rgb = parseHex(color);
  const candidates: { hex: string; step: number }[] = [];
  for (const target of [0, 255]) {
    for (let step = 1; step <= 100; step += 1) {
      const t = step / 100;
      const mixed = toHex(rgb.map((v) => v + (target - v) * t) as [number, number, number]);
      if (passes(mixed)) {
        candidates.push({ hex: mixed, step });
        break;
      }
    }
  }
  candidates.sort((a, b) => a.step - b.step);
  return candidates[0]?.hex ?? null;
}
