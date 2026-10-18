(() => {
  const EDIT_MAX = 1600;      // working copy shown in the crop editor
  const PREVIEW_SRC_MAX = 1200;
  const THUMB_SRC_MAX = 400;  // used for detection and strip thumbnails
  const EXPORT_SRC_MAX = 5000;
  const PAGE_SIZES = {        // portrait, in PDF points
    a4: [595.28, 841.89],
    letter: [612, 792],
    legal: [612, 1008],
  };
  const SIZE_LABELS = { a4: 'A4', letter: 'Letter', legal: 'Legal', fit: 'Crop aspect' };
  const DEFAULT_CORNERS = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]];

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), fileInput: $('fileInput'), cameraInput: $('cameraInput'),
    exportBtn: $('exportBtn'), settingsToggle: $('settingsToggle'), settingsPanel: $('settingsPanel'),
    pageSize: $('pageSize'), dpi: $('dpi'), quality: $('quality'), fileName: $('fileName'),
    pageList: $('pageList'), editorWrap: $('editorWrap'), editor: $('editorCanvas'),
    previewWrap: $('previewWrap'), preview: $('previewCanvas'), pageInfo: $('pageInfo'),
    filterButtons: $('filterButtons'), brightness: $('brightness'), contrast: $('contrast'),
    contrastRow: $('contrastRow'), rotL: $('rotL'), rotR: $('rotR'), autoBtn: $('autoBtn'),
    fullBtn: $('fullBtn'), applyAllBtn: $('applyAllBtn'), deleteBtn: $('deleteBtn'),
    overlay: $('overlay'), overlayText: $('overlayText'), overlayProgress: $('overlayProgress'),
    toast: $('toast'),
  };

  const state = {
    pages: [],
    current: null,
    previewSrc: null,       // ImageData of the current page for the live preview
    settings: { pageSize: 'a4', dpi: '200', quality: '0.85' },
    lastAdjust: { filter: 'doc', brightness: 0, contrast: 0 },
  };
  let nextId = 1;

  // ---------- settings ----------

  try {
    Object.assign(state.settings, JSON.parse(localStorage.getItem('pdfmaker.settings') || '{}'));
  } catch { /* storage unavailable */ }
  for (const k of ['pageSize', 'dpi', 'quality']) {
    el[k].value = state.settings[k];
    el[k].addEventListener('change', () => {
      state.settings[k] = el[k].value;
      try { localStorage.setItem('pdfmaker.settings', JSON.stringify(state.settings)); } catch { /* ignore */ }
      if (k === 'pageSize') { schedulePreview(); state.pages.forEach(renderThumb); }
    });
  }
  const today = new Date();
  el.fileName.value = `scan-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

  el.settingsToggle.addEventListener('click', () => {
    const open = el.settingsPanel.hidden;
    el.settingsPanel.hidden = !open;
    el.settingsToggle.setAttribute('aria-expanded', String(open));
  });

  // ---------- helpers ----------

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function scaledCanvas(source, srcW, srcH, max) {
    const s = Math.min(1, max / Math.max(srcW, srcH));
    const c = canvasOf(srcW * s, srcH * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  function imageDataOf(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  // Decodes a photo honoring EXIF orientation. Returns { source, width, height, close }.
  async function decode(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
  }

  function showOverlay(text, value, max) {
    el.overlay.hidden = false;
    el.overlayText.textContent = text;
    el.overlayProgress.max = max;
    el.overlayProgress.value = value;
  }

  // Corners in pixel coordinates of a w×h image, rotated for output orientation.
  function outputQuad(page, w, h) {
    const q = page.corners.map(([x, y]) => [x * w, y * h]);
    return Warp.rotateCorners(q, page.rot);
  }

  // Page size in points, oriented to match the crop's shape.
  function pageDims(page) {
    const { w, h } = Warp.quadSize(outputQuad(page, page.width, page.height));
    const landscape = w > h;
    let pw, ph;
    if (state.settings.pageSize === 'fit') {
      pw = 595.28;
      ph = pw * Math.max(w, h) / Math.max(1, Math.min(w, h));
    } else {
      [pw, ph] = PAGE_SIZES[state.settings.pageSize] || PAGE_SIZES.a4;
    }
    return landscape ? { ptW: ph, ptH: pw, landscape } : { ptW: pw, ptH: ph, landscape };
  }

  // Warp + filter a page from src ImageData into an output of the given long side.
  function renderPage(page, src, longSide) {
    const { ptW, ptH } = pageDims(page);
    const k = longSide / Math.max(ptW, ptH);
    const outW = Math.max(1, Math.round(ptW * k)), outH = Math.max(1, Math.round(ptH * k));
    const img = Warp.warp(src, outputQuad(page, src.width, src.height), outW, outH);
    Filters.apply(img, page.filter, page.brightness, page.contrast);
    return img;
  }

  // ---------- adding pages ----------

  async function addFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i.test(f.name));
    if (!images.length) return;
    let failed = 0;
    for (let i = 0; i < images.length; i++) {
      showOverlay(`Loading photo ${i + 1} of ${images.length}…`, i, images.length);
      await nextFrame();
      try {
        const page = await loadPage(images[i]);
        state.pages.push(page);
        renderStrip();
        if (!state.current) selectPage(page);
      } catch (err) {
        console.error(err);
        failed++;
      }
    }
    el.overlay.hidden = true;
    if (failed) toast(`${failed} file(s) could not be read by this browser (HEIC works only in Safari).`);
    updateEmpty();
  }

  async function loadPage(file) {
    const dec = await decode(file);
    const edit = scaledCanvas(dec.source, dec.width, dec.height, EDIT_MAX);
    dec.close();
    const thumbSrc = imageDataOf(scaledCanvas(edit, edit.width, edit.height, THUMB_SRC_MAX));
    const page = {
      id: nextId++, file, name: file.name,
      width: dec.width, height: dec.height,
      edit, thumbSrc,
      corners: Detect.detect(thumbSrc) || DEFAULT_CORNERS.map((p) => p.slice()),
      rot: 0,
      ...state.lastAdjust,
      thumbUrl: '',
    };
    renderThumb(page);
    return page;
  }

  function renderThumb(page) {
    const img = renderPage(page, page.thumbSrc, 220);
    const c = canvasOf(img.width, img.height);
    c.getContext('2d').putImageData(img, 0, 0);
    page.thumbUrl = c.toDataURL('image/jpeg', 0.8);
    const node = el.pageList.querySelector(`[data-id="${page.id}"] img`);
    if (node) node.src = page.thumbUrl;
  }

  el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });
  el.cameraInput.addEventListener('change', () => { addFiles(el.cameraInput.files); el.cameraInput.value = ''; });

  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', (e) => {
    document.body.classList.remove('dragging');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  // ---------- page strip ----------

  let dragId = null;

  function renderStrip() {
    el.pageList.replaceChildren(...state.pages.map((page, i) => {
      const li = document.createElement('li');
      li.dataset.id = page.id;
      li.draggable = true;
      li.className = page === state.current ? 'active' : '';
      li.innerHTML = `
        <img alt="">
        <div class="thumb-bar">
          <span class="num">${i + 1}</span>
          <button type="button" data-act="up" title="Move earlier" ${i === 0 ? 'disabled' : ''}>‹</button>
          <button type="button" data-act="down" title="Move later" ${i === state.pages.length - 1 ? 'disabled' : ''}>›</button>
          <button type="button" data-act="del" title="Delete">✕</button>
        </div>`;
      li.querySelector('img').src = page.thumbUrl;
      return li;
    }));
    el.exportBtn.disabled = !state.pages.length;
  }

  el.pageList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const idx = state.pages.findIndex((p) => p.id === Number(li.dataset.id));
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'up' || act === 'down') {
      const j = act === 'up' ? idx - 1 : idx + 1;
      [state.pages[idx], state.pages[j]] = [state.pages[j], state.pages[idx]];
      renderStrip();
    } else if (act === 'del') {
      deletePage(state.pages[idx]);
    } else {
      selectPage(state.pages[idx]);
    }
  });

  el.pageList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    dragId = li ? Number(li.dataset.id) : null;
    e.dataTransfer.effectAllowed = 'move';
  });
  el.pageList.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.pageList.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target.closest('li');
    const from = state.pages.findIndex((p) => p.id === dragId);
    let to = target ? state.pages.findIndex((p) => p.id === Number(target.dataset.id)) : state.pages.length - 1;
    const [moved] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, moved);
    dragId = null;
    renderStrip();
  });
  el.pageList.addEventListener('dragend', () => { dragId = null; });

  function deletePage(page) {
    const idx = state.pages.indexOf(page);
    state.pages.splice(idx, 1);
    if (state.current === page) {
      state.current = null;
      const next = state.pages[Math.min(idx, state.pages.length - 1)];
      if (next) selectPage(next);
    }
    renderStrip();
    updateEmpty();
  }

  function updateEmpty() {
    el.app.classList.toggle('empty', !state.pages.length);
    if (!state.pages.length) state.previewSrc = null;
    else { resizeCanvases(); }
  }

  // ---------- selecting / controls ----------

  function selectPage(page) {
    state.current = page;
    state.previewSrc = imageDataOf(scaledCanvas(page.edit, page.edit.width, page.edit.height, PREVIEW_SRC_MAX));
    syncControls();
    renderStrip();
    el.app.classList.remove('empty');
    resizeCanvases();
  }

  function syncControls() {
    const p = state.current;
    if (!p) return;
    for (const b of el.filterButtons.children) b.setAttribute('aria-checked', String(b.dataset.filter === p.filter));
    el.brightness.value = p.brightness;
    el.contrast.value = p.contrast;
    el.contrast.disabled = p.filter === 'bw';
    el.contrastRow.classList.toggle('disabled', p.filter === 'bw');
  }

  el.filterButtons.replaceChildren(...Filters.LIST.map((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.dataset.filter = f.id;
    b.textContent = f.label;
    return b;
  }));

  function adjusted() {
    const p = state.current;
    state.lastAdjust = { filter: p.filter, brightness: p.brightness, contrast: p.contrast };
    syncControls();
    schedulePreview();
    scheduleThumb();
  }

  el.filterButtons.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !state.current) return;
    state.current.filter = b.dataset.filter;
    adjusted();
  });
  el.brightness.addEventListener('input', () => { if (state.current) { state.current.brightness = Number(el.brightness.value); adjusted(); } });
  el.contrast.addEventListener('input', () => { if (state.current) { state.current.contrast = Number(el.contrast.value); adjusted(); } });
  for (const input of [el.brightness, el.contrast]) {
    input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); });
  }

  function cornersChanged() {
    drawEditor();
    schedulePreview();
    scheduleThumb();
  }

  el.rotL.addEventListener('click', () => { if (state.current) { state.current.rot = (state.current.rot + 3) % 4; cornersChanged(); } });
  el.rotR.addEventListener('click', () => { if (state.current) { state.current.rot = (state.current.rot + 1) % 4; cornersChanged(); } });
  el.autoBtn.addEventListener('click', () => {
    const p = state.current;
    if (!p) return;
    const found = Detect.detect(p.thumbSrc);
    if (!found) toast('Could not find the page edges; adjust the corners by hand.');
    p.corners = found || DEFAULT_CORNERS.map((c) => c.slice());
    cornersChanged();
  });
  el.fullBtn.addEventListener('click', () => {
    if (!state.current) return;
    state.current.corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    cornersChanged();
  });
  el.applyAllBtn.addEventListener('click', () => {
    const p = state.current;
    if (!p) return;
    for (const q of state.pages) {
      q.filter = p.filter; q.brightness = p.brightness; q.contrast = p.contrast;
      if (q !== p) renderThumb(q);
    }
    toast(`Applied “${Filters.LIST.find((f) => f.id === p.filter).label}” to all ${state.pages.length} pages.`);
  });
  el.deleteBtn.addEventListener('click', () => { if (state.current) deletePage(state.current); });

  let thumbTimer;
  function scheduleThumb() {
    clearTimeout(thumbTimer);
    const p = state.current;
    thumbTimer = setTimeout(() => p && renderThumb(p), 300);
  }

  // ---------- crop editor ----------

  const view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  const drag = { active: false, handle: -1, start: null, startCorners: null, pos: null };
  let selectedHandle = 0;

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    view.dpr = dpr;
    for (const [canvas, wrap] of [[el.editor, el.editorWrap], [el.preview, el.previewWrap]]) {
      const r = wrap.getBoundingClientRect();
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    }
    drawEditor();
    renderPreview(false);
  }
  new ResizeObserver(() => { if (state.current) resizeCanvases(); }).observe(el.editorWrap);
  new ResizeObserver(() => { if (state.current) resizeCanvases(); }).observe(el.previewWrap);

  // Handles: 0-3 corners, 4-7 edge midpoints (edge i joins corner i and i+1).
  function handlePoints() {
    const p = state.current;
    const W = p.edit.width, H = p.edit.height;
    const pts = p.corners.map(([x, y]) => [view.ox + x * W * view.scale, view.oy + y * H * view.scale]);
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return pts;
  }

  function drawEditor() {
    const p = state.current;
    const ctx = el.editor.getContext('2d');
    const cw = el.editor.width / view.dpr, ch = el.editor.height / view.dpr;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!p) return;

    const pad = 18;
    const W = p.edit.width, H = p.edit.height;
    view.scale = Math.min((cw - pad * 2) / W, (ch - pad * 2) / H);
    view.ox = (cw - W * view.scale) / 2;
    view.oy = (ch - H * view.scale) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.edit, view.ox, view.oy, W * view.scale, H * view.scale);

    const pts = handlePoints();
    const quad = pts.slice(0, 4);

    // dim everything outside the crop
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.ox, view.oy, W * view.scale, H * view.scale);
    ctx.moveTo(...quad[0]);
    for (let i = 1; i < 4; i++) ctx.lineTo(...quad[i]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill('evenodd');
    ctx.restore();

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fed';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(...quad[0]);
    for (let i = 1; i < 4; i++) ctx.lineTo(...quad[i]);
    ctx.closePath();
    ctx.stroke();

    // the edge that becomes the top of the page (depends on rotation)
    const topIdx = (4 - p.rot) % 4;
    const ta = quad[topIdx], tb = quad[(topIdx + 1) % 4];
    ctx.lineWidth = 5;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.moveTo(...ta);
    ctx.lineTo(...tb);
    ctx.stroke();
    drawTopMarker(ctx, ta, tb, quad, accent);

    pts.forEach(([x, y], i) => {
      const corner = i < 4;
      const active = drag.active ? drag.handle === i : selectedHandle === i && document.activeElement === el.editor;
      ctx.beginPath();
      if (corner) ctx.arc(x, y, active ? 11 : 9, 0, Math.PI * 2);
      else ctx.roundRect(x - 6, y - 6, 12, 12, 3);
      ctx.fillStyle = active ? accent : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? '#fff' : accent;
      ctx.stroke();
    });

    if (drag.active && drag.handle < 4) drawLoupe(ctx, cw, pts[drag.handle]);
  }

  function drawTopMarker(ctx, a, b, quad, color) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const cx = quad.reduce((s, q) => s + q[0], 0) / 4, cy = quad.reduce((s, q) => s + q[1], 0) / 4;
    let nx = mx - cx, ny = my - cy;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const tip = [mx + nx * 16, my + ny * 16];
    ctx.beginPath();
    ctx.moveTo(...tip);
    ctx.lineTo(mx + nx * 4 - ny * 9, my + ny * 4 + nx * 9);
    ctx.lineTo(mx + nx * 4 + ny * 9, my + ny * 4 - nx * 9);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Magnified view around the dragged corner, placed away from the finger.
  function drawLoupe(ctx, cw, [px, py]) {
    const p = state.current;
    const r = 60, zoom = 3;
    const cx = px < cw / 2 ? cw - r - 12 : r + 12;
    const cy = r + 12;
    const srcScale = view.scale * zoom; // display px per edit px inside the loupe
    const ix = (px - view.ox) / view.scale, iy = (py - view.oy) / view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.clip();
    ctx.drawImage(p.edit, cx - ix * srcScale, cy - iy * srcScale, p.edit.width * srcScale, p.edit.height * srcScale);
    ctx.strokeStyle = 'rgba(255,60,60,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  function eventPos(e) {
    const r = el.editor.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function toNorm([x, y]) {
    const p = state.current;
    return [(x - view.ox) / (p.edit.width * view.scale), (y - view.oy) / (p.edit.height * view.scale)];
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  el.editor.addEventListener('pointerdown', (e) => {
    if (!state.current) return;
    const pos = eventPos(e);
    const pts = handlePoints();
    const reach = e.pointerType === 'touch' ? 36 : 22;
    let best = -1, bestD = Infinity;
    pts.forEach(([x, y], i) => {
      // corners win ties over edge handles
      const d = Math.hypot(x - pos[0], y - pos[1]) - (i < 4 ? 4 : 0);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (bestD > reach) return;
    e.preventDefault();
    el.editor.focus({ preventScroll: true });
    el.editor.setPointerCapture(e.pointerId);
    Object.assign(drag, {
      active: true, handle: best, start: toNorm(pos),
      startCorners: state.current.corners.map((c) => c.slice()),
    });
    if (best < 4) selectedHandle = best;
    drawEditor();
  });

  el.editor.addEventListener('pointermove', (e) => {
    const pos = eventPos(e);
    if (!drag.active) {
      if (!state.current) return;
      const near = handlePoints().some(([x, y]) => Math.hypot(x - pos[0], y - pos[1]) < 22);
      el.editor.style.cursor = near ? 'grab' : 'default';
      return;
    }
    const [nx, ny] = toNorm(pos);
    const dx = nx - drag.start[0], dy = ny - drag.start[1];
    const p = state.current;
    const idx = drag.handle < 4 ? [drag.handle] : [drag.handle - 4, (drag.handle - 3) % 4];
    for (const i of idx) {
      p.corners[i] = [clamp01(drag.startCorners[i][0] + dx), clamp01(drag.startCorners[i][1] + dy)];
    }
    drawEditor();
    schedulePreview(true);
  });

  function endDrag() {
    if (!drag.active) return;
    drag.active = false;
    drawEditor();
    schedulePreview();
    scheduleThumb();
  }
  el.editor.addEventListener('pointerup', endDrag);
  el.editor.addEventListener('pointercancel', endDrag);
  el.editor.addEventListener('focus', drawEditor);
  el.editor.addEventListener('blur', drawEditor);

  // Keyboard: Tab-like cycling with 1-4 / C, arrow keys nudge the selected corner.
  el.editor.addEventListener('keydown', (e) => {
    const p = state.current;
    if (!p) return;
    if (e.key === 'c' || e.key === 'C') { selectedHandle = (selectedHandle + 1) % 4; drawEditor(); e.preventDefault(); return; }
    if (/^[1-4]$/.test(e.key)) { selectedHandle = Number(e.key) - 1; drawEditor(); return; }
    const step = (e.shiftKey ? 10 : 1);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const c = p.corners[selectedHandle];
    c[0] = clamp01(c[0] + d[0] / (p.edit.width * view.scale));
    c[1] = clamp01(c[1] + d[1] / (p.edit.height * view.scale));
    cornersChanged();
  });

  // ---------- live preview ----------

  let previewQueued = false, previewFast = false;
  function schedulePreview(fast = false) {
    previewFast = previewFast || fast;
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      const f = previewFast && drag.active;
      previewFast = false;
      renderPreview(f);
    });
  }

  function renderPreview(fast) {
    const p = state.current;
    const ctx = el.preview.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.preview.width, el.preview.height);
    if (!p || !state.previewSrc) return;

    const { ptW, ptH, landscape } = pageDims(p);
    const pad = 14 * view.dpr;
    const fit = Math.min((el.preview.width - pad * 2) / ptW, (el.preview.height - pad * 2) / ptH);
    const dispW = ptW * fit, dispH = ptH * fit;
    const longSide = Math.min(Math.max(dispW, dispH), fast ? 520 : 1100);
    const img = renderPage(p, state.previewSrc, longSide);

    const tmp = canvasOf(img.width, img.height);
    tmp.getContext('2d').putImageData(img, 0, 0);
    const x = (el.preview.width - dispW) / 2, y = (el.preview.height - dispH) / 2;
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 10 * view.dpr;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, dispW, dispH);
    ctx.shadowColor = 'transparent';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, x, y, dispW, dispH);

    const idx = state.pages.indexOf(p) + 1;
    el.pageInfo.textContent = `Page ${idx}/${state.pages.length} · ${SIZE_LABELS[state.settings.pageSize]} ${landscape ? 'landscape' : 'portrait'}`;
  }

  // ---------- export ----------

  async function exportPdf() {
    if (!state.pages.length) return;
    const dpi = Number(state.settings.dpi);
    const quality = Number(state.settings.quality);
    const out = [];
    el.exportBtn.disabled = true;
    try {
      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        showOverlay(`Rendering page ${i + 1} of ${state.pages.length}…`, i, state.pages.length);
        await nextFrame();

        const { ptW, ptH } = pageDims(page);
        const outW = Math.round(ptW / 72 * dpi), outH = Math.round(ptH / 72 * dpi);

        // Decode at full resolution, but only as large as the output needs.
        const dec = await decode(page.file);
        const { w: qw, h: qh } = Warp.quadSize(outputQuad(page, dec.width, dec.height));
        const need = Math.max(outW, outH) * 1.3 / Math.max(qw, qh, 1);
        const s = Math.min(1, need, EXPORT_SRC_MAX / Math.max(dec.width, dec.height));
        const srcCanvas = scaledCanvas(dec.source, dec.width, dec.height, Math.max(dec.width, dec.height) * s);
        dec.close();
        const src = imageDataOf(srcCanvas);
        srcCanvas.width = srcCanvas.height = 0;

        const img = Warp.warp(src, outputQuad(page, src.width, src.height), outW, outH);
        Filters.apply(img, page.filter, page.brightness, page.contrast);
        const c = canvasOf(outW, outH);
        c.getContext('2d').putImageData(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
        c.width = c.height = 0;
        out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), imgW: outW, imgH: outH, ptW, ptH });
      }
      showOverlay('Building PDF…', 1, 1);
      await nextFrame();
      const pdf = PDF.build(out);
      const name = (el.fileName.value.trim() || 'scan').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '') + '.pdf';
      const url = URL.createObjectURL(pdf);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`Saved ${name} (${(pdf.size / 1048576).toFixed(1)} MB, ${out.length} page${out.length > 1 ? 's' : ''}).`);
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${err.message || err}`);
    } finally {
      el.overlay.hidden = true;
      el.exportBtn.disabled = !state.pages.length;
    }
  }
  el.exportBtn.addEventListener('click', exportPdf);
})();
