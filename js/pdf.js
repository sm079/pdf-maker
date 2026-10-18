// Minimal PDF writer: one full-page JPEG per page.
const PDF = (() => {
  const enc = new TextEncoder();
  const num = (v) => (Math.round(v * 100) / 100).toString();

  // pages: [{ jpeg: Uint8Array, imgW, imgH, ptW, ptH }]. Returns a Blob.
  function build(pages) {
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const push = (bytes) => { chunks.push(bytes); pos += bytes.length; };
    const text = (s) => push(enc.encode(s));
    const obj = (id, body) => { offsets[id] = pos; text(`${id} 0 obj\n${body}\nendobj\n`); };

    text('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    // ids: 1 catalog, 2 page tree, then 3 per page: page, content, image
    const pageIds = pages.map((_, i) => 3 + i * 3);
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

    pages.forEach((p, i) => {
      const pid = pageIds[i], cid = pid + 1, iid = pid + 2;
      obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.ptW)} ${num(p.ptH)}] ` +
        `/Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
      const content = `q ${num(p.ptW)} 0 0 ${num(p.ptH)} 0 0 cm /Im0 Do Q`;
      obj(cid, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      offsets[iid] = pos;
      text(`${iid} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.imgW} /Height ${p.imgH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      text('\nendstream\nendobj\n');
    });

    const size = 3 + pages.length * 3;
    const xref = pos;
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    text(table);
    text(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  return { build };
})();
