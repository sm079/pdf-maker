// Lightweight page detection: finds the largest bright region (the paper)
// and takes its extreme points as the four corners.
const Detect = (() => {
  // img: small ImageData (a few hundred px). Returns normalized corners
  // [tl, tr, br, bl] or null when no convincing page was found.
  function detect(img) {
    const { width: w, height: h, data: d } = img;
    const n = w * h;
    let g = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    }
    g = Filters.boxBlur(g, w, h, 2);
    const t = Filters.otsu(g);

    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = g[i] > t ? 1 : 0;

    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let best = null;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0, area = 0;
      const ext = { minS: Infinity, maxS: -Infinity, minD: Infinity, maxD: -Infinity };
      const pts = {};
      stack[sp++] = start; seen[start] = 1;
      while (sp) {
        const i = stack[--sp];
        const x = i % w, y = (i / w) | 0;
        area++;
        const s = x + y, df = x - y;
        if (s < ext.minS) { ext.minS = s; pts.tl = [x, y]; }
        if (s > ext.maxS) { ext.maxS = s; pts.br = [x + 1, y + 1]; }
        if (df > ext.maxD) { ext.maxD = df; pts.tr = [x + 1, y]; }
        if (df < ext.minD) { ext.minD = df; pts.bl = [x, y + 1]; }
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
        if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
      }
      if (!best || area > best.area) best = { area, pts };
    }
    if (!best || best.area < 0.15 * n) return null;

    const q = [best.pts.tl, best.pts.tr, best.pts.br, best.pts.bl];
    if (quadArea(q) < 0.15 * n) return null;
    return q.map(([x, y]) => [x / w, y / h]);
  }

  function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  return { detect };
})();
