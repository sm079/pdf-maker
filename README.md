# Photo to PDF

A static, dependency-free web app that turns photos of documents into a PDF.
Everything runs in the browser; no photos are uploaded anywhere.

## Features

- Add many photos at once (file picker, drag and drop, or camera on mobile).
  EXIF orientation is respected, so portrait and landscape shots both work.
- Automatic page-edge detection pre-places the four crop corners.
- Drag the corners (or edge midpoints) to adjust; a magnifier appears while
  dragging. Arrow keys nudge the selected corner (`C` or `1`–`4` to pick one,
  `Shift` for bigger steps).
- The crop is perspective-corrected into a standard page: A4, Letter, Legal,
  or the crop's own aspect ratio. Portrait/landscape is chosen from the crop
  shape; rotate buttons turn the page in 90° steps (the highlighted edge is the
  top of the page).
- Filters: Original, Enhanced (shadow removal + white balance), Grayscale,
  Document (flattened lighting, white paper), B&W (adaptive binarization), plus
  brightness and contrast.
- Live preview of the final page, reorderable page strip, and export at
  150/200/300 DPI.

## Running

Open `index.html` directly in a browser, or serve the folder with any static
server, e.g.:

```sh
python -m http.server 8000
```

It can be deployed as-is to GitHub Pages, Netlify, or similar.

## Layout

| File             | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `js/app.js`      | UI, state, crop editor, preview, export        |
| `js/warp.js`     | Perspective (homography) warp                  |
| `js/filters.js`  | Document-style image filters                   |
| `js/detect.js`   | Page-corner detection                          |
| `js/pdf.js`      | Minimal PDF writer (embeds JPEG pages)         |
