/**
 * The dominant colours of an image, computed in the browser (the image itself never leaves the device): downscale,
 * bucket every pixel to 5 bits per channel, merge buckets that look alike, then keep the most-used colours plus the
 * most vivid ones (a brand colour is often a small area of a screenshot).
 */
export interface PaletteColor { hex: string; weight: number }

const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const sat = (r: number, g: number, b: number) => { const max = Math.max(r, g, b), min = Math.min(r, g, b); return max ? (max - min) / max : 0; };

export function paletteFromPixels(data: Uint8ClampedArray, max = 10): PaletteColor[] {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bk = buckets.get(key);
    if (bk) { bk.r += r; bk.g += g; bk.b += b; bk.n++; } else buckets.set(key, { r, g, b, n: 1 });
    total++;
  }
  if (!total) return [];
  const colors = [...buckets.values()].map((x) => ({ r: x.r / x.n, g: x.g / x.n, b: x.b / x.n, n: x.n })).sort((a, b) => b.n - a.n);
  const merged: typeof colors = [];
  for (const c of colors) {
    const near = merged.find((m) => Math.hypot(m.r - c.r, m.g - c.g, m.b - c.b) < 28);
    if (near) { const n = near.n + c.n; near.r = (near.r * near.n + c.r * c.n) / n; near.g = (near.g * near.n + c.g * c.n) / n; near.b = (near.b * near.n + c.b * c.n) / n; near.n = n; }
    else if (merged.length < 64) merged.push({ ...c });
  }
  merged.sort((a, b) => b.n - a.n);
  const picked = merged.slice(0, Math.max(3, max - 3));
  const vivid = merged.filter((c) => !picked.includes(c) && c.n / total > 0.002).sort((a, b) => sat(b.r, b.g, b.b) * Math.sqrt(b.n) - sat(a.r, a.g, a.b) * Math.sqrt(a.n)).slice(0, max - picked.length);
  return [...picked, ...vivid].map((c) => ({ hex: toHex(c.r, c.g, c.b), weight: Math.round((c.n / total) * 1000) / 1000 }));
}

export async function paletteFromFile(file: File, max = 10): Promise<PaletteColor[]> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser can't read images.");
    ctx.drawImage(img, 0, 0, w, h);
    return paletteFromPixels(ctx.getImageData(0, 0, w, h).data, max);
  } finally {
    URL.revokeObjectURL(url);
  }
}
