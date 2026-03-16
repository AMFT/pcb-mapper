/**
 * PCB Mapper v2 — Gerber Preview
 * Renders a visual preview of the exported Gerber layers onto a canvas.
 * Shows copper, mask, silk, outline, and drill layers with toggleable visibility.
 */

const LAYER_COLORS = {
  'F_Cu':    { fill: '#b87333', stroke: '#d4956b', label: 'Front Copper' },
  'B_Cu':    { fill: '#3355aa', stroke: '#5577cc', label: 'Back Copper' },
  'F_Mask':  { fill: '#22aa44', stroke: '#33cc55', label: 'Front Mask' },
  'B_Mask':  { fill: '#227744', stroke: '#339966', label: 'Back Mask' },
  'F_Silk':  { fill: '#ffffff', stroke: '#ffffff', label: 'Front Silk' },
  'B_Silk':  { fill: '#cccccc', stroke: '#cccccc', label: 'Back Silk' },
  'Edge':    { fill: '#ffcc00', stroke: '#ffcc00', label: 'Board Edge' },
  'Drill':   { fill: '#ff4444', stroke: '#ff4444', label: 'Drills' },
  'F_Paste': { fill: '#ccaa88', stroke: '#ccaa88', label: 'Front Paste' },
  'B_Paste': { fill: '#8888aa', stroke: '#8888aa', label: 'Back Paste' },
};

let previewCanvas = null;
let previewCtx = null;
let parsedLayers = {};
let layerVisibility = {};
let previewScale = 1;
let previewOffset = { x: 0, y: 0 };

export function openGerberPreview(boardData) {
  if (!boardData) return;

  const el = document.getElementById('gerber-preview');
  if (!el) return;
  el.style.display = 'block';

  // Create/reuse canvas
  if (!previewCanvas) {
    previewCanvas = document.createElement('canvas');
    previewCanvas.style.cssText = 'width:100%;height:100%;background:#1a1a2e;cursor:crosshair;';
    const canvasArea = document.getElementById('gp-canvas');
    if (canvasArea) {
      canvasArea.innerHTML = '';
      canvasArea.appendChild(previewCanvas);
    }
  }

  // Parse board data into render-ready structures
  _parseBoardToLayers(boardData);

  // Initialize visibility
  Object.keys(LAYER_COLORS).forEach(k => { layerVisibility[k] = true; });
  // Hide back layers by default for clarity
  layerVisibility['B_Cu'] = false;
  layerVisibility['B_Mask'] = false;
  layerVisibility['B_Silk'] = false;
  layerVisibility['B_Paste'] = false;

  // Build layer toggle UI
  _buildLayerToggles();

  // Size canvas
  _resizePreviewCanvas();
  window.addEventListener('resize', _resizePreviewCanvas);

  // Mouse wheel zoom
  previewCanvas.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    previewScale *= factor;
    _renderPreview();
  };

  // Initial render
  _autoFit(boardData);
  _renderPreview();
}

export function closeGerberPreview() {
  const el = document.getElementById('gerber-preview');
  if (el) el.style.display = 'none';
  window.removeEventListener('resize', _resizePreviewCanvas);
}

function _parseBoardToLayers(bd) {
  parsedLayers = {};
  const bw = bd.boardWidth || 100;
  const bh = bd.boardHeight || 100;

  // Calculate scale from board outline or dimensions
  let pixW = 1, pixH = 1;
  if (bd.outline && bd.outline.length >= 3) {
    const xs = bd.outline.map(p => p.x), ys = bd.outline.map(p => p.y);
    pixW = Math.max(...xs) - Math.min(...xs);
    pixH = Math.max(...ys) - Math.min(...ys);
  } else {
    pixW = bw; pixH = bh; // fallback
  }
  const scaleX = bw / pixW;
  const scaleY = bh / pixH;
  const scale = Math.min(scaleX, scaleY);

  const toMM = (px) => px * scale;

  // Edge cuts (board outline)
  if (bd.outline && bd.outline.length >= 3) {
    parsedLayers['Edge'] = {
      paths: [{ type: 'polygon', points: bd.outline.map(p => ({ x: toMM(p.x), y: toMM(p.y) })) }]
    };
  }

  // Front copper: pads, vias, traces on top
  const fCu = [], bCu = [], fMask = [], bMask = [], fSilk = [], bSilk = [], drills = [];

  // Markers (pads, vias, holes)
  bd.markers.forEach(m => {
    const x = toMM(m.x), y = toMM(m.y);
    if (m.t === 'marker') {
      const r = toMM(m.holeSize || 8) / 2;
      // Copper annular ring
      fCu.push({ type: 'circle', x, y, r: r * 1.5 });
      bCu.push({ type: 'circle', x, y, r: r * 1.5 });
      // Drill
      drills.push({ type: 'circle', x, y, r });
      // Mask opening
      fMask.push({ type: 'circle', x, y, r: r * 1.6 });
      bMask.push({ type: 'circle', x, y, r: r * 1.6 });
    } else if (m.t === 'smd') {
      const w = toMM(m.padWidth || 14), h = toMM(m.padHeight || 8);
      const target = m.layer === 'bottom' ? bCu : fCu;
      const maskTarget = m.layer === 'bottom' ? bMask : fMask;
      target.push({ type: 'rect', x: x - w / 2, y: y - h / 2, w, h });
      maskTarget.push({ type: 'rect', x: x - w / 2, y: y - h / 2, w, h });
    } else if (m.t === 'pin') {
      const r = toMM(3);
      const target = m.layer === 'bottom' ? bCu : fCu;
      target.push({ type: 'circle', x, y, r });
      drills.push({ type: 'circle', x, y, r: r * 0.6 });
    }
  });

  // Traces
  (bd.traces || []).forEach(t => {
    if (!t.points || t.points.length < 2) return;
    const target = t.layer === 'bottom' ? bCu : fCu;
    target.push({
      type: 'polyline',
      points: t.points.map(p => ({ x: toMM(p.x), y: toMM(p.y) })),
      width: toMM(t.width || 9),
    });
  });

  // Silk (component outlines)
  bd.components.forEach(c => {
    if (!c.bounds) return;
    const b = c.bounds;
    const target = c.layer === 'bottom' ? bSilk : fSilk;
    target.push({
      type: 'rect',
      x: toMM(b.x1), y: toMM(b.y1),
      w: toMM(b.x2 - b.x1), h: toMM(b.y2 - b.y1),
      stroke: true,
    });
    // Label
    target.push({
      type: 'text',
      x: toMM((b.x1 + b.x2) / 2),
      y: toMM((b.y1 + b.y2) / 2),
      text: c.label,
    });
  });

  // Pours
  (bd.pours || []).forEach(p => {
    if (!p.points || p.points.length < 3) return;
    const target = p.layer === 'bottom' ? bCu : fCu;
    target.push({ type: 'polygon', points: p.points.map(pt => ({ x: toMM(pt.x), y: toMM(pt.y) })) });
  });

  parsedLayers['F_Cu'] = { paths: fCu };
  parsedLayers['B_Cu'] = { paths: bCu };
  parsedLayers['F_Mask'] = { paths: fMask };
  parsedLayers['B_Mask'] = { paths: bMask };
  parsedLayers['F_Silk'] = { paths: fSilk };
  parsedLayers['B_Silk'] = { paths: bSilk };
  parsedLayers['Drill'] = { paths: drills };
}

function _autoFit(bd) {
  if (!previewCanvas) return;
  const bw = bd.boardWidth || 100;
  const bh = bd.boardHeight || 100;
  const cw = previewCanvas.width;
  const ch = previewCanvas.height;
  previewScale = Math.min((cw - 40) / bw, (ch - 40) / bh);
  previewOffset = { x: (cw - bw * previewScale) / 2, y: (ch - bh * previewScale) / 2 };
}

function _resizePreviewCanvas() {
  if (!previewCanvas) return;
  const parent = previewCanvas.parentElement;
  if (!parent) return;
  previewCanvas.width = parent.clientWidth;
  previewCanvas.height = parent.clientHeight;
  previewCtx = previewCanvas.getContext('2d');
  _renderPreview();
}

function _renderPreview() {
  if (!previewCtx || !previewCanvas) return;
  const ctx = previewCtx;
  const w = previewCanvas.width, h = previewCanvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, w, h);

  // Draw grid
  ctx.strokeStyle = '#1a1a3a';
  ctx.lineWidth = 0.5;
  const gridStep = previewScale; // 1mm grid
  if (gridStep > 3) {
    for (let x = previewOffset.x % gridStep; x < w; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = previewOffset.y % gridStep; y < h; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  // Render order: mask → copper → silk → edge → drills
  const renderOrder = ['B_Mask', 'F_Mask', 'B_Cu', 'F_Cu', 'B_Paste', 'F_Paste', 'B_Silk', 'F_Silk', 'Edge', 'Drill'];

  renderOrder.forEach(layerName => {
    if (!layerVisibility[layerName]) return;
    const layer = parsedLayers[layerName];
    if (!layer || !layer.paths) return;

    const colors = LAYER_COLORS[layerName];
    ctx.globalAlpha = layerName.includes('Mask') ? 0.3 : 0.8;

    layer.paths.forEach(item => {
      const s = previewScale;
      const ox = previewOffset.x;
      const oy = previewOffset.y;

      switch (item.type) {
        case 'circle':
          ctx.beginPath();
          ctx.arc(ox + item.x * s, oy + item.y * s, item.r * s, 0, Math.PI * 2);
          ctx.fillStyle = colors.fill;
          ctx.fill();
          break;

        case 'rect':
          if (item.stroke) {
            ctx.strokeStyle = colors.stroke;
            ctx.lineWidth = 1;
            ctx.strokeRect(ox + item.x * s, oy + item.y * s, item.w * s, item.h * s);
          } else {
            ctx.fillStyle = colors.fill;
            ctx.fillRect(ox + item.x * s, oy + item.y * s, item.w * s, item.h * s);
          }
          break;

        case 'polygon':
          if (item.points.length < 3) break;
          ctx.beginPath();
          ctx.moveTo(ox + item.points[0].x * s, oy + item.points[0].y * s);
          item.points.forEach((p, i) => { if (i > 0) ctx.lineTo(ox + p.x * s, oy + p.y * s); });
          ctx.closePath();
          if (layerName === 'Edge') {
            ctx.strokeStyle = colors.stroke;
            ctx.lineWidth = 2;
            ctx.stroke();
          } else {
            ctx.fillStyle = colors.fill;
            ctx.fill();
          }
          break;

        case 'polyline':
          if (item.points.length < 2) break;
          ctx.beginPath();
          ctx.moveTo(ox + item.points[0].x * s, oy + item.points[0].y * s);
          item.points.forEach((p, i) => { if (i > 0) ctx.lineTo(ox + p.x * s, oy + p.y * s); });
          ctx.strokeStyle = colors.stroke;
          ctx.lineWidth = Math.max(1, (item.width || 0.3) * s);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
          break;

        case 'text':
          ctx.fillStyle = colors.fill;
          ctx.font = `${Math.max(8, 2 * s)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(item.text, ox + item.x * s, oy + item.y * s);
          break;
      }
    });
  });

  ctx.globalAlpha = 1;

  // Scale bar
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Scale: 1mm = ${previewScale.toFixed(1)}px`, 8, h - 8);
}

function _buildLayerToggles() {
  const container = document.getElementById('gp-layers');
  if (!container) return;
  container.innerHTML = '';

  Object.entries(LAYER_COLORS).forEach(([key, info]) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;font-size:11px;';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = layerVisibility[key] !== false;
    cb.addEventListener('change', () => {
      layerVisibility[key] = cb.checked;
      _renderPreview();
    });

    const swatch = document.createElement('span');
    swatch.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:2px;background:${info.fill};`;

    const label = document.createElement('span');
    label.textContent = info.label;
    label.style.color = '#aaa';

    row.appendChild(cb);
    row.appendChild(swatch);
    row.appendChild(label);
    container.appendChild(row);
  });
}
