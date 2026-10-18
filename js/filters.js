// Image filters that make photographed pages look scanned.
const Filters = (() => {
  const LIST = [
    { id: 'original', label: 'Original' },
    { id: 'enhance', label: 'Enhanced' },
    { id: 'gray', label: 'Grayscale' },
    { id: 'doc', label: 'Document' },
    { id: 'bw', label: 'B&W' },
  ];

  function luminance(d, n) {
    const g = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    }
    return g;
  }

  function channel(d, n, k) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = d[i * 4 + k];
    return c;
  }

  // Separable sliding max (dilation) — removes dark text so only paper remains.
  function maxFilter(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
        tmp[y * w + x] = m;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
        out[y * w + x] = m;
      }
    }
    return out;
  }

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; c++; }
        tmp[y * w + x] = s / c;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; c++; }
        out[y * w + x] = s / c;
      }
    }
    return out;
  }

  // Divide a channel by its estimated paper background, flattening shadows and
  // uneven lighting so paper becomes ~255. Works on a coarse grid for speed.
  function normalize(ch, w, h) {
    const s = Math.max(1, Math.ceil(Math.max(w, h) / 160));
    const gw = Math.ceil(w / s), gh = Math.ceil(h / s);
    let grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let sum = 0, cnt = 0;
        const yEnd = Math.min(h, (gy + 1) * s), xEnd = Math.min(w, (gx + 1) * s);
        for (let y = gy * s; y < yEnd; y++) {
          for (let x = gx * s; x < xEnd; x++) { sum += ch[y * w + x]; cnt++; }
        }
        grid[gy * gw + gx] = sum / cnt;
      }
    }
    grid = maxFilter(grid, gw, gh, 3);
    grid = boxBlur(grid, gw, gh, 4);

    const x0s = new Int32Array(w), x1s = new Int32Array(w), txs = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max((x + 0.5) / s - 0.5, 0), gw - 1);
      x0s[x] = fx | 0; x1s[x] = Math.min(x0s[x] + 1, gw - 1); txs[x] = fx - x0s[x];
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(Math.max((y + 0.5) / s - 0.5, 0), gh - 1);
      const y0 = fy | 0, y1 = Math.min(y0 + 1, gh - 1), ty = fy - y0;
      const r0 = y0 * gw, r1 = y1 * gw;
      for (let x = 0; x < w; x++) {
        const a = grid[r0 + x0s[x]], b = grid[r0 + x1s[x]];
        const c = grid[r1 + x0s[x]], d = grid[r1 + x1s[x]];
        const top = a + (b - a) * txs[x], bot = c + (d - c) * txs[x];
        const bg = Math.max(top + (bot - top) * ty, 1);
        const i = y * w + x;
        ch[i] = Math.min(255, (ch[i] / bg) * 255);
      }
    }
  }

  function percentile(ch, p) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < ch.length; i++) hist[ch[i] | 0]++;
    const target = ch.length * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  function otsu(ch) {
    const hist = new Float64Array(256);
    for (let i = 0; i < ch.length; i++) hist[ch[i] | 0]++;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = ch.length - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = v; }
    }
    return t;
  }

  function levels(ch, lo, hi, gamma) {
    const span = Math.max(hi - lo, 1);
    for (let i = 0; i < ch.length; i++) {
      const v = Math.min(Math.max((ch[i] - lo) / span, 0), 1);
      ch[i] = 255 * Math.pow(v, gamma);
    }
  }

  function writeGray(d, g) {
    for (let i = 0, j = 0; i < g.length; i++, j += 4) d[j] = d[j + 1] = d[j + 2] = g[i];
  }

  function brightnessContrast(d, n, brightness, contrast) {
    if (!brightness && !contrast) return;
    const c = Math.pow(2, contrast / 100);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - 128) * c + 128 + brightness * 1.28;
    for (let j = 0; j < n * 4; j += 4) {
      d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]];
    }
  }

  // Applies a filter in place. brightness/contrast are -100..100.
  function apply(img, filter, brightness = 0, contrast = 0) {
    const { width: w, height: h, data: d } = img;
    const n = w * h;
    switch (filter) {
      case 'gray':
        writeGray(d, luminance(d, n));
        break;
      case 'doc': {
        const g = luminance(d, n);
        normalize(g, w, h);
        levels(g, Math.min(percentile(g, 0.01), 100), 225, 1.3);
        writeGray(d, g);
        break;
      }
      case 'bw': {
        const g = luminance(d, n);
        normalize(g, w, h);
        const t = Math.min(Math.max(otsu(g), 100), 230) - brightness * 0.6;
        for (let i = 0; i < n; i++) g[i] = g[i] > t ? 255 : 0;
        writeGray(d, g);
        return; // brightness already used as threshold shift; contrast is meaningless
      }
      case 'enhance': {
        const chans = [0, 1, 2].map((k) => channel(d, n, k));
        for (const ch of chans) {
          normalize(ch, w, h);
          levels(ch, 10, 240, 1.15);
        }
        // mild saturation boost
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          const r = chans[0][i], g = chans[1][i], b = chans[2][i];
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          d[j] = l + (r - l) * 1.2;
          d[j + 1] = l + (g - l) * 1.2;
          d[j + 2] = l + (b - l) * 1.2;
        }
        break;
      }
    }
    brightnessContrast(d, n, brightness, contrast);
  }

  return { LIST, apply, otsu, boxBlur };
})();
