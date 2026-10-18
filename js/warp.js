// Perspective warp: maps a quadrilateral in a source image onto a rectangle.
const Warp = (() => {
  // Projective map from the unit square to quad q = [tl, tr, br, bl] (Heckbert).
  function squareToQuad(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx3 = x0 - x1 + x2 - x3;
    const dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0];
    }
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
    const g = (dx3 * dy2 - dx2 * dy3) / det;
    const h = (dx1 * dy3 - dx3 * dy1) / det;
    return [
      x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
      y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
      g, h,
    ];
  }

  // src: ImageData, q: corners in src pixel coordinates. Returns new ImageData.
  function warp(src, q, outW, outH) {
    const sw = src.width, sh = src.height, sd = src.data;
    const out = new ImageData(outW, outH);
    const od = out.data;
    const [a, b, c, d, e, f, g, h] = squareToQuad(q);
    const maxX = sw - 1, maxY = sh - 1;
    let o = 0;
    for (let y = 0; y < outH; y++) {
      const v = (y + 0.5) / outH;
      for (let x = 0; x < outW; x++) {
        const u = (x + 0.5) / outW;
        const den = g * u + h * v + 1;
        let sx = (a * u + b * v + c) / den - 0.5;
        let sy = (d * u + e * v + f) / den - 0.5;
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = x0 < maxX ? x0 + 1 : x0;
        const y1 = y0 < maxY ? y0 + 1 : y0;
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (let k = 0; k < 3; k++) {
          const top = sd[i00 + k] + (sd[i10 + k] - sd[i00 + k]) * fx;
          const bot = sd[i01 + k] + (sd[i11 + k] - sd[i01 + k]) * fx;
          od[o + k] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
        o += 4;
      }
    }
    return out;
  }

  // Approximate real-world width/height of the quad (average of opposite edges).
  function quadSize(q) {
    const dist = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
    return {
      w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2,
      h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2,
    };
  }

  // Rotate corner order so the output turns 90° clockwise per step.
  function rotateCorners(q, steps) {
    let r = q.slice();
    for (let i = 0; i < ((steps % 4) + 4) % 4; i++) r = [r[3], r[0], r[1], r[2]];
    return r;
  }

  return { warp, quadSize, rotateCorners };
})();
