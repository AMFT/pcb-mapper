/**
 * PCB Mapper v2 — Canvas Engine
 * Fabric.js 5.3.1 canvas system. Full port + enhancements from v1.
 * Enhancements: grid overlay, snap-to-grid, snap-to-pad, measurement tool,
 * rulers, improved trace drawing (length/angle snapping), multi-select,
 * copy/paste, better layer handling (dim vs hide).
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const NET_COLORS   = { power: '#ff4444', ground: '#888888', signal: '#4488ff', other: '#44cc44' };
const MARKER_COLORS = { via: '#ffaa00', hole: '#ff6600', pad: '#00ccaa', pin: '#ffcc00' };
const LAYER_COLORS  = { top: '#4488ff', bottom: '#ff4444' };
const TRACE_COLORS  = { top: '#44ff88', bottom: '#ff8844' };

// ─── Module state ─────────────────────────────────────────────────────────────
let canvas = null;
let board = null;
let cb = {};            // callbacks
let currentTool = 'select';
let currentLayer = 'top';
let currentMarkerType = 'via'; // via, hole, testpoint
let topImg = null;
let botImg = null;
let gridGroup = null;
let rulerH = null;
let rulerV = null;
let showGrid = false;
let snapToGrid = false;
let snapPad = true;       // snap-to-pad for trace drawing
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let drawPts = [];
let drawPreview = null;
let measurePts = [];
let measurePreview = null;
let netStart = null;
let compDragStart = null;
let compDragRect = null;
let compBounds = null;
let punchTarget = null;
let pendingPourPts = null;
let pinPlace = null;
let undoStack = [];
let redoStack = [];
let clipboard = [];
let lastTraceWidth = 3;
let showRulers = false;
let gridSize = 10;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initCanvas(canvasElementId, boardData, callbacks = {}) {
  board = boardData;
  cb = callbacks;
  gridSize = board.gridSize || 10;
  snapToGrid = board.snapToGrid || false;

  const wrap = document.getElementById(canvasElementId).parentElement;
  canvas = new fabric.Canvas(canvasElementId, {
    width: wrap.clientWidth,
    height: wrap.clientHeight,
    backgroundColor: '#0d1117',
    selection: true,
    preserveObjectStacking: true,
    fireRightClick: true,
    stopContextMenu: true,
    perPixelTargetFind: true,
    targetFindTolerance: 8,
  });

  canvas.on('mouse:down', onDown);
  canvas.on('mouse:move', onMove);
  canvas.on('mouse:up', onUp);
  canvas.on('mouse:wheel', onWheel);
  canvas.on('mouse:dblclick', onDblClick);
  canvas.on('selection:created', e => cb.onSelectionChange?.(e.selected));
  canvas.on('selection:updated', e => cb.onSelectionChange?.(e.selected));
  canvas.on('selection:cleared', () => cb.onSelectionChange?.([]));

  document.addEventListener('keydown', onKey);

  window.addEventListener('resize', () => {
    canvas.setDimensions({ width: wrap.clientWidth, height: wrap.clientHeight });
    if (showGrid) drawGridOverlay();
    if (showRulers) drawRulers();
  });

  // Build canvas from existing board data
  rebuildCanvas(board);
  return canvas;
}

// ─── Tool & layer switching ────────────────────────────────────────────────────
export function setTool(toolName) {
  if (pinPlace && toolName !== 'component') cancelPinPlace();
  currentTool = toolName;

  canvas.defaultCursor = toolName === 'pan' ? 'grab'
    : toolName === 'select' ? 'default'
    : toolName === 'measure' ? 'crosshair'
    : 'crosshair';

  canvas.selection = toolName === 'select';
  canvas.forEachObject(o => {
    if (!o.pcb || o.pcb.t === 'img' || o.pcb.t === 'grid' || o.pcb.t === 'ruler') return;
    if (o.pcb.t === 'component' || o.pcb.t === 'outline') { o.selectable = false; o.evented = false; return; }
    o.selectable = toolName === 'select';
    o.evented = true;
  });

  if (!['trace', 'pour', 'punchout', 'outline', 'measure'].includes(toolName)) {
    drawPts = [];
    removePrev();
  }
  if (toolName !== 'measure') { measurePts = []; removeMeasure(); }
  if (toolName !== 'net') netStart = null;
  if (toolName !== 'component') {
    compDragStart = null;
    if (compDragRect) { canvas.remove(compDragRect); compDragRect = null; }
  }
  if (toolName !== 'punchout') punchTarget = null;

  cb.onToolChange?.(toolName);

  const hints = {
    select: 'Click to select. Shift+click multi-select. Box drag for area select.',
    pan: 'Drag to pan. Scroll to zoom.',
    marker: 'Click to place via/hole marker.',
    component: 'Drag to draw IC/component outline.',
    smd: 'Click to place surface-mount pad.',
    net: 'Click two pins/markers to connect them.',
    trace: 'Click to add trace points. Enter to finish. Angle snaps to 45°.',
    pour: 'Click boundary points. Enter to finish pour zone.',
    punchout: 'First click a pour, then draw cutout boundary. Enter to finish.',
    outline: 'Click board edge corners. Enter to close outline.',
    align: 'Place alignment points on both layers. Use Align button after ≥2 pairs.',
    measure: 'Click two points to measure distance.',
  };
  cb.onStatusUpdate?.(hints[toolName] || '');
}

export function setLayer(layer) {
  currentLayer = layer;
  updateLayerVisibility();
}

// ─── Board images ─────────────────────────────────────────────────────────────
export function loadBoardImage(side, imageUrl) {
  return new Promise(resolve => {
    fabric.Image.fromURL(imageUrl, img => {
      img.set({ left: 0, top: 0, selectable: false, evented: false, opacity: 0.85 });
      img.pcb = { t: 'img', side };
      canvas.getObjects().filter(o => o.pcb?.t === 'img' && o.pcb.side === side).forEach(o => canvas.remove(o));
      if (side === 'top') topImg = img; else botImg = img;
      canvas.add(img);
      canvas.sendToBack(img);
      if (topImg && botImg) { canvas.sendToBack(botImg); canvas.sendToBack(topImg); }
      updateLayerVisibility();
      // Auto-zoom to fit
      const imgTgt = topImg || botImg;
      if (imgTgt) {
        const z = Math.min(canvas.width / imgTgt.width, canvas.height / imgTgt.height) * 0.85;
        canvas.setZoom(z);
        cb.onStatusUpdate?.(`Loaded ${side} image`);
      }
      resolve(img);
    });
  });
}

// ─── Alignment ────────────────────────────────────────────────────────────────
export function applyAlignment() {
  const tp = board.alignPoints.top;
  const bp = board.alignPoints.bottom;
  const n = Math.min(tp.length, bp.length);
  if (n < 2) { cb.onStatusUpdate?.('Need ≥2 matched alignment points on each layer'); return; }
  if (!botImg) { cb.onStatusUpdate?.('No bottom image loaded'); return; }

  // Sync align point positions from canvas objects
  syncPositions();
  const topPts = tp.slice(0, n).map(a => ({ x: a.x, y: a.y }));
  const botPts = bp.slice(0, n).map(a => ({ x: a.x, y: a.y }));

  // Full affine least-squares: topX = a*botX + b*botY + e, topY = c*botX + d*botY + f
  let sxx = 0, syy = 0, sxy = 0, sx = 0, sy = 0;
  let stx = 0, sty = 0, sxtx = 0, sytx = 0, sxty = 0, syty = 0;
  for (let i = 0; i < n; i++) {
    const bx = botPts[i].x, by = botPts[i].y;
    const tx = topPts[i].x, ty = topPts[i].y;
    sxx += bx * bx; syy += by * by; sxy += bx * by;
    sx += bx; sy += by; stx += tx; sty += ty;
    sxtx += bx * tx; sytx += by * tx; sxty += bx * ty; syty += by * ty;
  }

  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const det3 = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-10) { cb.onStatusUpdate?.('Alignment failed — degenerate points'); return; }
  const solve = (M, R) => {
    const D = det3(M);
    return [
      det3([[R[0], M[0][1], M[0][2]], [R[1], M[1][1], M[1][2]], [R[2], M[2][1], M[2][2]]]) / D,
      det3([[M[0][0], R[0], M[0][2]], [M[1][0], R[1], M[1][2]], [M[2][0], R[2], M[2][2]]]) / D,
      det3([[M[0][0], M[0][1], R[0]], [M[1][0], M[1][1], R[1]], [M[2][0], M[2][1], R[2]]]) / D,
    ];
  };
  const [a, b, e] = solve(M, [sxtx, sytx, stx]);
  const [c, d, f] = solve(M, [sxty, syty, sty]);

  const det = a * d - b * c;
  const hasReflection = det < 0;
  let aa = a, cc = c;
  if (hasReflection) { aa = -a; cc = -c; }

  const scaleX = Math.sqrt(aa * aa + cc * cc);
  const scaleY = Math.sqrt(b * b + d * d);
  const angle = Math.atan2(cc, aa);

  botImg.set({ flipX: hasReflection, scaleX, scaleY, angle: angle * 180 / Math.PI, left: 0, top: 0, originX: 'left', originY: 'top' });
  botImg.setCoords();

  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const bx0 = botPts[0].x, by0 = botPts[0].y;
  const expX = a * bx0 + b * by0 + e;
  const expY = c * bx0 + d * by0 + f;
  if (hasReflection) {
    const W = botImg.width;
    const rxRel = cosA * (W * scaleX - bx0 * scaleX) - sinA * (by0 * scaleY);
    const ryRel = sinA * (W * scaleX - bx0 * scaleX) + cosA * (by0 * scaleY);
    botImg.set({ left: expX - rxRel, top: expY - ryRel });
  } else {
    const rxRel = cosA * bx0 * scaleX - sinA * by0 * scaleY;
    const ryRel = sinA * bx0 * scaleX + cosA * by0 * scaleY;
    botImg.set({ left: expX - rxRel, top: expY - ryRel });
  }
  botImg.setCoords();
  canvas.requestRenderAll();

  let totalErr = 0;
  for (let i = 0; i < n; i++) {
    totalErr += Math.hypot(a * botPts[i].x + b * botPts[i].y + e - topPts[i].x, c * botPts[i].x + d * botPts[i].y + f - topPts[i].y);
  }
  cb.onStatusUpdate?.(`Aligned: ${hasReflection ? 'mirrored ' : ''}scale=${scaleX.toFixed(3)}, rot=${(angle * 180 / Math.PI).toFixed(1)}°, avg err=${(totalErr / n).toFixed(1)}px`);
}

export function flipBottom() {
  if (!botImg) { cb.onStatusUpdate?.('No bottom image'); return; }
  botImg.set('flipX', !botImg.flipX);
  canvas.requestRenderAll();
}

// ─── Zoom ──────────────────────────────────────────────────────────────────────
export function zoomToFit() {
  const img = topImg || botImg;
  if (!img) return;
  const z = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.85;
  canvas.setZoom(z);
  const vpt = canvas.viewportTransform;
  vpt[4] = (canvas.width - img.width * z) / 2;
  vpt[5] = (canvas.height - img.height * z) / 2;
  canvas.setViewportTransform(vpt);
  canvas.requestRenderAll();
}

export function setZoom(level) {
  const center = { x: canvas.width / 2, y: canvas.height / 2 };
  canvas.zoomToPoint(center, level);
  canvas.requestRenderAll();
}

export function getZoom() { return canvas.getZoom(); }
export function getCanvasInstance() { return canvas; }

// ─── Undo/Redo ────────────────────────────────────────────────────────────────
function pushUndo() {
  undoStack.push(JSON.stringify(board));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  cb.onDataChange?.(board);
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(board));
  const prev = JSON.parse(undoStack.pop());
  Object.assign(board, prev);
  rebuildCanvas(board);
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(board));
  const next = JSON.parse(redoStack.pop());
  Object.assign(board, next);
  rebuildCanvas(board);
}

// ─── Grid ─────────────────────────────────────────────────────────────────────
export function setGridVisible(visible) {
  showGrid = visible;
  if (visible) drawGridOverlay();
  else {
    canvas.getObjects().filter(o => o.pcb?.t === 'grid').forEach(o => canvas.remove(o));
    gridGroup = null;
    canvas.requestRenderAll();
  }
}

export function setMarkerType(type) { currentMarkerType = type; }
export function getMarkerType() { return currentMarkerType; }

export function setSnapToGrid(enabled) {
  snapToGrid = enabled;
  board.snapToGrid = enabled;
}

function drawGridOverlay() {
  canvas.getObjects().filter(o => o.pcb?.t === 'grid').forEach(o => canvas.remove(o));
  const z = canvas.getZoom();
  const vpt = canvas.viewportTransform;
  const W = canvas.width / z;
  const H = canvas.height / z;
  const ox = -vpt[4] / z;
  const oy = -vpt[5] / z;
  const step = gridSize;
  const startX = Math.floor(ox / step) * step;
  const startY = Math.floor(oy / step) * step;
  const lines = [];
  for (let x = startX; x < ox + W + step; x += step) {
    lines.push(new fabric.Line([x, oy - step, x, oy + H + step], {
      stroke: '#1a2a3a', strokeWidth: 1 / z, selectable: false, evented: false,
    }));
  }
  for (let y = startY; y < oy + H + step; y += step) {
    lines.push(new fabric.Line([ox - step, y, ox + W + step, y], {
      stroke: '#1a2a3a', strokeWidth: 1 / z, selectable: false, evented: false,
    }));
  }
  const group = new fabric.Group(lines, { selectable: false, evented: false });
  group.pcb = { t: 'grid' };
  canvas.add(group);
  canvas.sendToBack(group);
  canvas.requestRenderAll();
}

function snapPoint(p) {
  if (!snapToGrid) return p;
  return {
    x: Math.round(p.x / gridSize) * gridSize,
    y: Math.round(p.y / gridSize) * gridSize,
  };
}

function snapAngle(from, to) {
  // Snap to 0°, 45°, 90°, 135°, 180°, 225°, 270°, 315°
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) return to;
  const angle = Math.atan2(dy, dx);
  const snap45 = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: from.x + Math.cos(snap45) * len,
    y: from.y + Math.sin(snap45) * len,
  };
}

function nearestPad(p, maxDist = 20) {
  let best = null, bd = maxDist;
  canvas.getObjects().forEach(o => {
    if (!o.pcb || !['marker', 'smd', 'pin'].includes(o.pcb.t)) return;
    const d = Math.hypot((o.pcb.x || o.left) - p.x, (o.pcb.y || o.top) - p.y);
    if (d < bd) { bd = d; best = o.pcb; }
  });
  return best;
}

// ─── Rulers ───────────────────────────────────────────────────────────────────
function drawRulers() {
  canvas.getObjects().filter(o => o.pcb?.t === 'ruler').forEach(o => canvas.remove(o));
  // Minimal ruler implementation using Fabric rects
  const rSize = 20;
  const z = canvas.getZoom();
  const vpt = canvas.viewportTransform;
  const W = canvas.width;
  const H = canvas.height;
  // Horizontal ruler
  const hRect = new fabric.Rect({ left: 0, top: 0, width: W, height: rSize, fill: '#16213e', stroke: '#0f3460', strokeWidth: 1, selectable: false, evented: false });
  hRect.pcb = { t: 'ruler' };
  // Vertical ruler
  const vRect = new fabric.Rect({ left: 0, top: 0, width: rSize, height: H, fill: '#16213e', stroke: '#0f3460', strokeWidth: 1, selectable: false, evented: false });
  vRect.pcb = { t: 'ruler' };
  canvas.add(hRect, vRect);
  canvas.requestRenderAll();
}

// ─── Layer visibility ─────────────────────────────────────────────────────────
function updateLayerVisibility() {
  const s = currentLayer;
  if (topImg) topImg.set('visible', s === 'top' || s === 'both');
  if (botImg) {
    botImg.set('visible', s === 'bottom' || s === 'both');
    botImg.set('opacity', s === 'both' ? 0.4 : 0.85);
  }

  const throughTypes = new Set(['via', 'hole']);
  canvas.forEachObject(o => {
    if (!o.pcb || ['img', 'grid', 'ruler'].includes(o.pcb.t)) return;
    const layer = o.pcb.layer;

    // Through-board items always visible
    if (o.pcb.t === 'pin' || (o.pcb.t === 'marker' && throughTypes.has(o.pcb.markerType))) {
      o.set({ visible: true, opacity: 1 });
      return;
    }
    // Labels tied to through-board parents always visible
    if (o.pcb.lf || o.pcb.df) {
      const parentId = o.pcb.lf || o.pcb.df;
      const parent = board.markers.find(m => m.id === parentId);
      if (parent && (parent.t === 'pin' || throughTypes.has(parent.markerType))) {
        o.set({ visible: true, opacity: 1 });
        return;
      }
    }
    // Outline always visible
    if (o.pcb.t === 'outline') { o.set({ visible: true, opacity: 1 }); return; }
    // Align points always visible
    if (o.pcb.t === 'align') { o.set({ visible: true, opacity: 0.7 }); return; }

    if (s === 'both') {
      o.set('visible', true);
      // Dim the inactive layer slightly
      const isActive = !layer || layer === 'top'; // when both, top is "primary"
      o.set('opacity', 1);
    } else {
      if (!layer || layer === s) {
        o.set({ visible: true, opacity: 1 });
      } else {
        // Dim instead of hide
        o.set({ visible: true, opacity: 0.18 });
      }
    }
  });

  canvas.requestRenderAll();
}

// ─── Event handlers ───────────────────────────────────────────────────────────
function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();

  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && ((k === 'z' && e.shiftKey) || k === 'y')) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && k === 'c') { e.preventDefault(); copySelected(); return; }
  if (e.ctrlKey && k === 'v') { e.preventDefault(); pasteClipboard(); return; }

  if (k === 'enter') { e.preventDefault(); finishDraw(); return; }
  if (k === 'escape') {
    if (pinPlace) { cancelPinPlace(); return; }
    drawPts = []; measurePts = []; removePrev(); removeMeasure();
    setTool('select'); return;
  }
  if (k === 'delete' || k === 'backspace') { deleteSelected(); return; }

  if (pinPlace) return;

  const toolMap = { v: 'select', h: 'pan', m: 'marker', t: 'trace', n: 'net',
    p: 'pour', o: 'outline', a: 'align', u: 'measure' };
  if (!e.ctrlKey && !e.altKey) {
    if (k === 'c') { setTool('component'); return; }
    if (k === 'd' || k === 's') { setTool('smd'); return; }
    if (k === 'x') { setTool('punchout'); return; }
    if (toolMap[k]) { setTool(toolMap[k]); return; }
  }
}

function onWheel(opt) {
  opt.e.preventDefault();
  let z = canvas.getZoom() * (0.999 ** opt.e.deltaY);
  z = Math.max(0.02, Math.min(30, z));
  canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, z);
  if (showGrid) drawGridOverlay();
}

function onDown(opt) {
  const e = opt.e;
  if (e.button === 2) return; // right-click handled by caller (app.js context menu)

  if (currentTool === 'pan' || e.altKey || e.button === 1) {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    canvas.defaultCursor = 'grabbing';
    return;
  }

  const rawP = canvas.getPointer(e);
  const p = snapPoint(rawP);

  if (pinPlace) { placePin(p); return; }

  switch (currentTool) {
    case 'marker': pushUndo(); placeMarker(p); break;
    case 'smd':    pushUndo(); placeSMD(p); break;
    case 'component': startCompDrag(p); break;
    case 'net':    handleNet(p); break;
    case 'align':  placeAlignPoint(p); break;
    case 'measure': handleMeasure(rawP); break;
    case 'trace':
    case 'pour':
    case 'outline': {
      const snapped = (currentTool === 'trace' && drawPts.length > 0)
        ? snapAngle(drawPts[drawPts.length - 1], p)
        : p;
      // Snap to pad on trace start/end
      if (currentTool === 'trace' && snapPad) {
        const near = nearestPad(p, 20);
        if (near) drawPts.push({ x: near.x, y: near.y });
        else drawPts.push(snapped);
      } else {
        drawPts.push(snapped);
      }
      updatePrev(canvas.getPointer(e));
      break;
    }
    case 'punchout': handlePunchout(p, opt); break;
  }
}

function onMove(opt) {
  const p = canvas.getPointer(opt.e);
  cb.onStatusUpdate?.(formatPos(p.x, p.y));

  if (isPanning) {
    const vpt = canvas.viewportTransform;
    vpt[4] += opt.e.clientX - panStartX;
    vpt[5] += opt.e.clientY - panStartY;
    panStartX = opt.e.clientX;
    panStartY = opt.e.clientY;
    canvas.setViewportTransform(vpt);
    if (showGrid) drawGridOverlay();
    return;
  }

  if (currentTool === 'component' && compDragStart) updateCompDrag(p);
  if (['trace', 'pour', 'punchout', 'outline'].includes(currentTool) && drawPts.length) {
    let snapped = snapPoint(p);
    if (currentTool === 'trace' && drawPts.length > 0) snapped = snapAngle(drawPts[drawPts.length - 1], snapped);
    updatePrev(snapped);
    // Show live length for trace
    if (currentTool === 'trace' && drawPts.length > 0) {
      const last = drawPts[drawPts.length - 1];
      const len = Math.hypot(snapped.x - last.x, snapped.y - last.y);
      cb.onStatusUpdate?.(formatPos(p.x, p.y) + `  |  Trace: ${pxToMM(len).toFixed(2)}mm`);
    }
  }
  if (currentTool === 'measure' && measurePts.length === 1) updateMeasurePreview(p);
}

function onUp(opt) {
  if (isPanning) {
    isPanning = false;
    canvas.defaultCursor = currentTool === 'pan' ? 'grab' : 'crosshair';
    return;
  }
  if (currentTool === 'component' && compDragStart) {
    finishCompDrag(canvas.getPointer(opt.e));
  }
}

function onDblClick(opt) {
  const t = opt.target;
  if (t?.pcb && ['marker', 'smd', 'pin'].includes(t.pcb.t)) {
    const nl = prompt('Rename:', t.pcb.label || '');
    if (nl !== null) {
      pushUndo();
      t.pcb.label = nl;
      const tx = findLabelObj(t.pcb.id);
      if (tx) tx.set('text', nl);
      // Sync to data
      const md = board.markers.find(m => m.id === t.pcb.id);
      if (md) md.label = nl;
      canvas.requestRenderAll();
    }
    return;
  }
  finishDraw();
}

function formatPos(x, y) {
  const mm = board.boardWidth ? ` (${pxToMM(x).toFixed(1)}, ${pxToMM(y).toFixed(1)}mm)` : '';
  return `${Math.round(x)}, ${Math.round(y)}${mm}`;
}

function pxToMM(px) {
  if (!board.boardWidth || !board.boardHeight) return px;
  // Need outline bounds to compute scale... use canvas size as fallback
  const refPx = canvas.width * 0.85;
  return px * (board.boardWidth / refPx);
}

// ─── Placement ────────────────────────────────────────────────────────────────
function placeMarker(p, d) {
  const id = d?.id || ('o' + (board.idCounter++));
  const mt = d?.markerType || currentMarkerType || 'via';
  const prefixes = { via: 'V', hole: 'H', testpoint: 'TP' };
  const label = d?.label || ((prefixes[mt] || 'V') + id.replace('o', ''));
  const hs = d?.holeSize || (mt === 'hole' ? 11 : mt === 'via' ? 6 : 3);
  const layer = d?.layer || currentLayer;

  const circle = new fabric.Circle({
    left: d?.x ?? p.x, top: d?.y ?? p.y, radius: hs,
    fill: MARKER_COLORS[mt] || '#ffaa00', stroke: '#fff', strokeWidth: 1,
    originX: 'center', originY: 'center',
    selectable: currentTool === 'select', hasControls: false,
  });
  circle.pcb = { id, t: 'marker', label, markerType: mt, layer, x: d?.x ?? p.x, y: d?.y ?? p.y, holeSize: hs, testData: d?.testData || null };

  const tx = new fabric.Text(label, {
    left: (d?.x ?? p.x) + 10, top: (d?.y ?? p.y) - 8,
    fontSize: 11, fill: '#fff', fontFamily: 'monospace', selectable: false, evented: false,
  });
  tx.pcb = { lf: id };

  circle.on('moving', () => {
    tx.set({ left: circle.left + 10, top: circle.top - 8 });
    circle.pcb.x = circle.left; circle.pcb.y = circle.top;
    const md = board.markers.find(m => m.id === id);
    if (md) { md.x = circle.left; md.y = circle.top; }
    updateNets(id);
  });

  canvas.add(circle, tx);
  if (!d) board.markers.push(circle.pcb);
}

function placeSMD(p, d) {
  const id = d?.id || ('o' + (board.idCounter++));
  const label = d?.label || ('P' + id.replace('o', ''));
  const pw = d?.padWidth || 14, ph = d?.padHeight || 8;
  const layer = d?.layer || currentLayer;

  const rect = new fabric.Rect({
    left: d?.x ?? p.x, top: d?.y ?? p.y, width: pw, height: ph,
    fill: '#00ccaa', stroke: '#fff', strokeWidth: 1,
    originX: 'center', originY: 'center', rx: 2, ry: 2,
    selectable: currentTool === 'select', hasControls: false,
  });
  rect.pcb = { id, t: 'smd', label, layer, x: d?.x ?? p.x, y: d?.y ?? p.y, padWidth: pw, padHeight: ph, testData: d?.testData || null };

  const tx = new fabric.Text(label, {
    left: (d?.x ?? p.x) + 12, top: (d?.y ?? p.y) - 6,
    fontSize: 10, fill: '#00ccaa', fontFamily: 'monospace', selectable: false, evented: false,
  });
  tx.pcb = { lf: id };

  rect.on('moving', () => {
    tx.set({ left: rect.left + 12, top: rect.top - 6 });
    rect.pcb.x = rect.left; rect.pcb.y = rect.top;
    const md = board.markers.find(m => m.id === id);
    if (md) { md.x = rect.left; md.y = rect.top; }
    updateNets(id);
  });

  canvas.add(rect, tx);
  if (!d) board.markers.push(rect.pcb);
}

// ─── Components ───────────────────────────────────────────────────────────────
function startCompDrag(p) {
  if (pinPlace) return;
  compDragStart = p;
  compDragRect = new fabric.Rect({
    left: p.x, top: p.y, width: 1, height: 1,
    fill: 'rgba(100,100,255,0.12)', stroke: '#6666ff', strokeWidth: 1.5,
    strokeDashArray: [4, 2], selectable: false, evented: false,
  });
  canvas.add(compDragRect);
}

function updateCompDrag(p) {
  if (!compDragRect) return;
  const s = compDragStart;
  compDragRect.set({
    left: Math.min(s.x, p.x), top: Math.min(s.y, p.y),
    width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y),
  });
  canvas.requestRenderAll();
}

export function finishCompDrag(p) {
  if (!compDragStart) return;
  const s = compDragStart;
  if (compDragRect) { canvas.remove(compDragRect); compDragRect = null; }
  const w = Math.abs(p.x - s.x), h = Math.abs(p.y - s.y);
  if (w < 5 && h < 5) { compDragStart = null; return; }
  const x1 = Math.min(s.x, p.x), y1 = Math.min(s.y, p.y);
  compBounds = { x1, y1, x2: x1 + w, y2: y1 + h };
  compDragStart = null;
  // Signal app to show component dialog
  cb.onToolChange?.('component:bounds', compBounds);
}

export function confirmComponent(label, compType, pinCount, value) {
  pushUndo();
  const id = 'o' + (board.idCounter++);
  buildCompOutline(compBounds, id, label, compType, pinCount, value, currentLayer);
  // Enter pin placement mode
  pinPlace = { compId: id, label, pinCount, placed: 0, startNum: 1 };
  canvas.defaultCursor = 'crosshair';
  cb.onToolChange?.('component:pinplace', pinPlace);
}

function buildCompOutline(b, id, label, compType, pinCount, value, layer) {
  const w = b.x2 - b.x1, h = b.y2 - b.y1;
  const rect = new fabric.Rect({
    left: b.x1, top: b.y1, width: w, height: h,
    fill: 'rgba(100,100,255,0.08)', stroke: '#6666ff', strokeWidth: 1.5,
    strokeDashArray: [4, 2], selectable: false, evented: true,
    hasControls: false, lockMovementX: true, lockMovementY: true,
  });
  rect.pcb = { id, t: 'component', label, compType, pinCount, value, layer: layer || currentLayer, bounds: { ...b } };

  const tx = new fabric.Text(`${label}${value ? ' — ' + value : ''}`, {
    left: b.x1 + 4, top: b.y1 - 16, fontSize: 12, fill: '#aaf',
    fontFamily: 'monospace', fontWeight: 'bold', selectable: false, evented: false,
  });
  tx.pcb = { lf: id };

  if (compType === 'ic') {
    const dot = new fabric.Circle({ left: b.x1 + 6, top: b.y1 + 6, radius: 3, fill: '#aaf', selectable: false, evented: false, originX: 'center', originY: 'center' });
    dot.pcb = { df: id };
    canvas.add(dot);
  }

  canvas.add(rect, tx);
  board.components.push(rect.pcb);
}

// ─── Pin placement ────────────────────────────────────────────────────────────
function placePin(p, d) {
  const s = pinPlace;
  if (!s && !d) return;

  const pn = d ? d.pinNum : s.startNum + s.placed;
  const pid = d ? d.id : (s.compId + '_p' + pn);
  const fill = d?.testData?._status ? ({ pass: '#00ff00', fail: '#ff0000', suspect: '#ffaa00', untested: '#888888' }[d.testData._status] || '#fc0') : '#fc0';

  const pin = new fabric.Circle({
    left: d?.x ?? p.x, top: d?.y ?? p.y, radius: 4,
    fill, stroke: '#fff', strokeWidth: 1,
    originX: 'center', originY: 'center', selectable: currentTool === 'select', hasControls: false,
  });
  const pinLabel = d?.label || (s ? (s.label + ' P' + pn) : ('' + pn));
  pin.pcb = { id: pid, t: 'pin', label: pinLabel, parentId: d?.parentId ?? s?.compId, pinNum: pn, x: d?.x ?? p.x, y: d?.y ?? p.y, layer: d?.layer || currentLayer, testData: d?.testData || null };

  const pl = new fabric.Text('' + pn, {
    left: (d?.x ?? p.x) + 8, top: (d?.y ?? p.y) - 6,
    fontSize: 10, fill: '#fc0', fontFamily: 'monospace', selectable: false, evented: false,
  });
  pl.pcb = { lf: pid };

  pin.on('moving', () => {
    pl.set({ left: pin.left + 8, top: pin.top - 6 });
    pin.pcb.x = pin.left; pin.pcb.y = pin.top;
    const md = board.markers.find(m => m.id === pid);
    if (md) { md.x = pin.left; md.y = pin.top; }
    updateNets(pid);
  });

  canvas.add(pin, pl);
  if (!d) {
    board.markers.push(pin.pcb);
    s.placed++;
    if (s.placed >= s.pinCount) {
      pinPlace = null;
      canvas.defaultCursor = 'default';
      cb.onToolChange?.('component:done', s);
      setTool('select');
    } else {
      cb.onToolChange?.('component:pinplace', s);
    }
  }
}

function cancelPinPlace() {
  pinPlace = null;
  canvas.defaultCursor = 'default';
  cb.onToolChange?.('component:cancelled');
  setTool('select');
}

// ─── Nets ──────────────────────────────────────────────────────────────────────
function handleNet(p) {
  const t = nearestPad(p, 25);
  if (!t) { cb.onStatusUpdate?.('Click on a marker or pin'); return; }
  if (!netStart) {
    netStart = t;
    cb.onStatusUpdate?.(`From: ${t.label} — click destination`);
  } else {
    if (netStart.id === t.id) { netStart = null; cb.onStatusUpdate?.('Cancelled'); return; }
    pushUndo();
    buildNet(netStart, t, null);
    netStart = null;
    cb.onStatusUpdate?.('Net created');
    cb.onDataChange?.(board);
  }
}

function buildNet(from, to, d) {
  const id = d?.id || ('o' + (board.idCounter++));
  const nt = d?.netType || 'signal';
  const fromX = from.x || 0, fromY = from.y || 0;
  const toX = to.x || 0, toY = to.y || 0;
  const line = new fabric.Line([fromX, fromY, toX, toY], {
    stroke: NET_COLORS[nt], strokeWidth: 2,
    selectable: currentTool === 'select', hasControls: false, strokeDashArray: [6, 3],
  });
  line.pcb = { id, t: 'net', fromId: from.id, toId: to.id, netType: nt, label: d?.label || '' };
  canvas.add(line);
  canvas.sendToBack(line);
  if (!d) board.nets.push(line.pcb);
}

function updateNets(markerId) {
  const obj = findObj(markerId);
  if (!obj) return;
  const mx = obj.left, my = obj.top;
  canvas.getObjects().forEach(o => {
    if (!o.pcb || o.pcb.t !== 'net') return;
    if (o.pcb.fromId === markerId) o.set({ x1: mx, y1: my });
    if (o.pcb.toId === markerId) o.set({ x2: mx, y2: my });
  });
  canvas.requestRenderAll();
}

// ─── Draw tools (trace/pour/punchout/outline) ──────────────────────────────────
function updatePrev(cursor) {
  removePrev();
  if (!drawPts.length) return;
  const pts = [...drawPts, cursor];
  const isPoly = ['pour', 'punchout', 'outline'].includes(currentTool);
  const colors = { trace: TRACE_COLORS[currentLayer] || '#44ff88', pour: '#ff8844', punchout: '#ff4444', outline: '#ffffff' };
  const col = colors[currentTool] || '#44ff88';

  if (isPoly) {
    drawPreview = new fabric.Polygon(pts, {
      stroke: col, strokeWidth: 1.5, fill: col + '18',
      strokeDashArray: [4, 4], selectable: false, evented: false,
    });
  } else {
    drawPreview = new fabric.Polyline(pts, {
      stroke: col, strokeWidth: 2, fill: 'transparent',
      selectable: false, evented: false,
    });
  }
  canvas.add(drawPreview);
  canvas.requestRenderAll();
}

function removePrev() {
  if (drawPreview) { canvas.remove(drawPreview); drawPreview = null; }
}

function finishDraw() {
  removePrev();
  if (currentTool === 'trace' && drawPts.length >= 2) {
    pushUndo();
    const id = 'o' + (board.idCounter++);
    const w = lastTraceWidth;
    const col = TRACE_COLORS[currentLayer] || '#44ff88';
    const pl = new fabric.Polyline([...drawPts], {
      stroke: col, strokeWidth: w, fill: 'transparent',
      selectable: currentTool === 'select', hasControls: false,
      strokeLineCap: 'round', strokeLineJoin: 'round',
    });
    pl.pcb = { id, t: 'trace', points: [...drawPts], layer: currentLayer, width: w };
    canvas.add(pl);
    board.traces.push(pl.pcb);
    drawPts = [];
    cb.onDataChange?.(board);
    cb.onStatusUpdate?.('Trace created');
  } else if (currentTool === 'pour' && drawPts.length >= 3) {
    pendingPourPts = [...drawPts];
    drawPts = [];
    cb.onToolChange?.('pour:confirm', pendingPourPts);
  } else if (currentTool === 'punchout' && drawPts.length >= 3 && punchTarget) {
    pushUndo();
    const pd = punchTarget.pcb;
    const cutId = 'o' + (board.idCounter++);
    const pourData = board.pours.find(p => p.id === pd.id);
    if (pourData) {
      if (!pourData.cutouts) pourData.cutouts = [];
      pourData.cutouts.push({ id: cutId, points: [...drawPts] });
    }
    rebuildPour(pourData || pd);
    drawPts = [];
    punchTarget = null;
    cb.onDataChange?.(board);
    cb.onStatusUpdate?.('Cutout applied');
  } else if (currentTool === 'outline' && drawPts.length >= 3) {
    pushUndo();
    canvas.getObjects().filter(o => o.pcb?.t === 'outline').forEach(o => canvas.remove(o));
    const pts = [...drawPts];
    const pg = new fabric.Polygon(pts, {
      stroke: '#fff', strokeWidth: 2, fill: 'transparent',
      strokeDashArray: [8, 4], selectable: false, evented: false,
    });
    pg.pcb = { id: 'o' + (board.idCounter++), t: 'outline', points: pts };
    canvas.add(pg);
    canvas.sendToBack(pg);
    board.outline = pts;
    drawPts = [];
    cb.onDataChange?.(board);
    cb.onStatusUpdate?.('Board outline set');
  } else {
    drawPts = [];
  }
}

export function confirmPour(label, netType, color, opacity) {
  const pts = pendingPourPts;
  if (!pts || pts.length < 3) return;
  pushUndo();
  const id = 'o' + (board.idCounter++);
  const pourData = { id, t: 'pour', points: [...pts], layer: currentLayer, label, netType, color, opacity, cutouts: [] };
  board.pours.push(pourData);
  renderPour(pourData);
  pendingPourPts = null;
  cb.onDataChange?.(board);
}

function handlePunchout(p, opt) {
  if (!punchTarget) {
    const t = opt.target;
    if (t?.pcb?.t === 'pour') {
      punchTarget = t;
      cb.onStatusUpdate?.(`Pour "${t.pcb.label}" selected. Draw cutout, Enter to finish.`);
    } else {
      cb.onStatusUpdate?.('Click on a pour first');
    }
    return;
  }
  drawPts.push(p);
  updatePrev(p);
}

function renderPour(pd) {
  const color = pd.color || NET_COLORS[pd.netType] || '#44cc44';
  const opacity = pd.opacity || 0.25;
  let path = 'M ' + pd.points.map(p => `${p.x} ${p.y}`).join(' L ') + ' Z';
  (pd.cutouts || []).forEach(c => {
    const rev = [...c.points].reverse();
    path += ' M ' + rev.map(p => `${p.x} ${p.y}`).join(' L ') + ' Z';
  });
  const pathObj = new fabric.Path(path, {
    fill: color, fillRule: 'evenodd', opacity,
    stroke: color, strokeWidth: 1.5,
    selectable: false, hasControls: false, evented: true,
  });
  pathObj.pcb = { ...pd, t: 'pour' };
  canvas.add(pathObj);
  canvas.sendToBack(pathObj);
  const cx = pd.points.reduce((a, p) => a + p.x, 0) / pd.points.length;
  const cy = pd.points.reduce((a, p) => a + p.y, 0) / pd.points.length;
  const lbl = new fabric.Text(pd.label, {
    left: cx, top: cy, fontSize: 12, fill: color, fontFamily: 'monospace',
    fontWeight: 'bold', originX: 'center', originY: 'center', selectable: false, evented: false,
  });
  lbl.pcb = { lf: pd.id };
  canvas.add(lbl);
}

function rebuildPour(pd) {
  canvas.getObjects().filter(o => o.pcb && (o.pcb.id === pd.id || o.pcb.lf === pd.id)).forEach(o => canvas.remove(o));
  renderPour(pd);
}

// ─── Align points ──────────────────────────────────────────────────────────────
function placeAlignPoint(p, d) {
  const side = d?.side || (currentLayer === 'bottom' ? 'bottom' : 'top');
  const pts = board.alignPoints[side];
  const idx = d ? d.idx : pts.length + 1;
  const id = d?.id || (`al_${side[0]}_${idx}`);
  const x = d?.x ?? p.x, y = d?.y ?? p.y;
  const color = side === 'top' ? '#00ff00' : '#ff00ff';

  const m = new fabric.Circle({ left: x, top: y, radius: 8, fill: 'transparent', stroke: color, strokeWidth: 2, originX: 'center', originY: 'center', selectable: currentTool === 'select', hasControls: false });
  m.pcb = { id, t: 'align', side, idx, x, y };
  const c1 = new fabric.Line([x - 12, y, x + 12, y], { stroke: color, strokeWidth: 1, selectable: false, evented: false });
  const c2 = new fabric.Line([x, y - 12, x, y + 12], { stroke: color, strokeWidth: 1, selectable: false, evented: false });
  c1.pcb = { df: id }; c2.pcb = { df: id };
  const lbl = new fabric.Text(`A${idx}(${side[0].toUpperCase()})`, { left: x + 14, top: y - 6, fontSize: 10, fill: color, fontFamily: 'monospace', selectable: false, evented: false });
  lbl.pcb = { lf: id };
  m.on('moving', () => {
    m.pcb.x = m.left; m.pcb.y = m.top;
    lbl.set({ left: m.left + 14, top: m.top - 6 });
    c1.set({ x1: m.left - 12, y1: m.top, x2: m.left + 12, y2: m.top });
    c2.set({ x1: m.left, y1: m.top - 12, x2: m.left, y2: m.top + 12 });
    const ap = board.alignPoints[side].find(a => a.id === id);
    if (ap) { ap.x = m.left; ap.y = m.top; }
  });
  canvas.add(m, c1, c2, lbl);
  if (!d) {
    pts.push({ id, x, y });
    cb.onStatusUpdate?.(`Align: ${board.alignPoints.top.length}T / ${board.alignPoints.bottom.length}B — need ≥2 matched pairs`);
  }
}

// ─── Measurement tool ─────────────────────────────────────────────────────────
function handleMeasure(p) {
  if (measurePts.length === 0) {
    measurePts.push(p);
    cb.onStatusUpdate?.('Click second point to measure');
  } else {
    const p1 = measurePts[0];
    const dx = p.x - p1.x, dy = p.y - p1.y;
    const pxDist = Math.hypot(dx, dy);
    const mmDist = pxToMM(pxDist);
    removeMeasure();
    // Draw persistent measurement line
    const line = new fabric.Line([p1.x, p1.y, p.x, p.y], { stroke: '#ffff00', strokeWidth: 1.5, strokeDashArray: [4, 2], selectable: false, evented: false });
    const midX = (p1.x + p.x) / 2, midY = (p1.y + p.y) / 2;
    const label = new fabric.Text(`${pxDist.toFixed(0)}px / ${mmDist.toFixed(2)}mm`, { left: midX, top: midY - 16, fontSize: 11, fill: '#ffff00', fontFamily: 'monospace', selectable: false, evented: false, originX: 'center' });
    line.pcb = { t: 'measure_result' };
    label.pcb = { t: 'measure_result' };
    canvas.add(line, label);
    cb.onStatusUpdate?.(`Distance: ${pxDist.toFixed(1)}px = ${mmDist.toFixed(2)}mm`);
    measurePts = [];
  }
}

function updateMeasurePreview(p) {
  removeMeasure();
  if (!measurePts.length) return;
  const p1 = measurePts[0];
  const dx = p.x - p1.x, dy = p.y - p1.y;
  const dist = Math.hypot(dx, dy);
  measurePreview = new fabric.Group([
    new fabric.Line([p1.x, p1.y, p.x, p.y], { stroke: '#ffff00', strokeWidth: 1.5, strokeDashArray: [4, 2] }),
    new fabric.Text(`${dist.toFixed(0)}px / ${pxToMM(dist).toFixed(2)}mm`, { left: (p1.x + p.x) / 2, top: (p1.y + p.y) / 2 - 16, fontSize: 11, fill: '#ffff00', fontFamily: 'monospace', originX: 'center' }),
  ], { selectable: false, evented: false });
  canvas.add(measurePreview);
  canvas.requestRenderAll();
}

function removeMeasure() {
  if (measurePreview) { canvas.remove(measurePreview); measurePreview = null; }
  canvas.getObjects().filter(o => o.pcb?.t === 'measure_result').forEach(o => canvas.remove(o));
}

// ─── Delete ────────────────────────────────────────────────────────────────────
function deleteSelected() {
  const active = canvas.getActiveObjects();
  if (!active.length) return;
  pushUndo();
  active.forEach(o => { if (o.pcb?.id) deleteById(o.pcb.id, true); else canvas.remove(o); });
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  cb.onDataChange?.(board);
}

export function deleteById(id, batch) {
  if (!batch) pushUndo();

  // Delete component + its pins
  const compIdx = board.components.findIndex(c => c.id === id);
  if (compIdx !== -1) {
    const pinIds = board.markers.filter(m => m.t === 'pin' && m.parentId === id).map(m => m.id);
    pinIds.forEach(pid => {
      canvas.getObjects().filter(o => o.pcb && (o.pcb.id === pid || o.pcb.lf === pid)).forEach(o => canvas.remove(o));
      board.nets = board.nets.filter(n => n.fromId !== pid && n.toId !== pid);
      canvas.getObjects().filter(o => o.pcb?.t === 'net' && (o.pcb.fromId === pid || o.pcb.toId === pid)).forEach(o => canvas.remove(o));
    });
    board.markers = board.markers.filter(m => !(m.t === 'pin' && m.parentId === id));
    board.components.splice(compIdx, 1);
  }

  canvas.getObjects().filter(o => o.pcb && (o.pcb.id === id || o.pcb.lf === id || o.pcb.df === id)).forEach(o => canvas.remove(o));
  canvas.getObjects().filter(o => o.pcb?.t === 'net' && (o.pcb.fromId === id || o.pcb.toId === id)).forEach(o => {
    board.nets = board.nets.filter(n => n.id !== o.pcb.id);
    canvas.remove(o);
  });

  board.markers = board.markers.filter(m => m.id !== id);
  board.nets = board.nets.filter(n => n.id !== id);
  board.traces = board.traces.filter(t => t.id !== id);
  board.pours = board.pours.filter(p => p.id !== id);
  for (const side of ['top', 'bottom']) {
    board.alignPoints[side] = board.alignPoints[side].filter(a => a.id !== id);
  }

  if (!batch) { canvas.requestRenderAll(); cb.onDataChange?.(board); }
}

// ─── Copy/Paste ────────────────────────────────────────────────────────────────
function copySelected() {
  const active = canvas.getActiveObjects();
  clipboard = active
    .filter(o => o.pcb && ['marker', 'smd', 'component', 'pin'].includes(o.pcb.t))
    .map(o => JSON.parse(JSON.stringify(o.pcb)));
  cb.onStatusUpdate?.(`Copied ${clipboard.length} item(s)`);
}

function pasteClipboard() {
  if (!clipboard.length) return;
  pushUndo();
  const offset = 20;
  clipboard.forEach(item => {
    const newId = 'o' + (board.idCounter++);
    if (item.t === 'marker') {
      placeMarker({ x: item.x + offset, y: item.y + offset }, { ...item, id: newId, x: item.x + offset, y: item.y + offset });
      board.markers.push({ ...item, id: newId, x: item.x + offset, y: item.y + offset });
    } else if (item.t === 'smd') {
      placeSMD({ x: item.x + offset, y: item.y + offset }, { ...item, id: newId, x: item.x + offset, y: item.y + offset });
      board.markers.push({ ...item, id: newId, x: item.x + offset, y: item.y + offset });
    }
  });
  canvas.requestRenderAll();
  cb.onDataChange?.(board);
}

// ─── Select & pan to item ─────────────────────────────────────────────────────
export function selectItem(id) {
  const obj = findObj(id);
  if (!obj) return;
  obj.set({ selectable: true, evented: true });
  canvas.discardActiveObject();
  canvas.setActiveObject(obj);
  // Pan to center
  const vpt = canvas.viewportTransform;
  const z = canvas.getZoom();
  vpt[4] = canvas.width / 2 - (obj.left || 0) * z;
  vpt[5] = canvas.height / 2 - (obj.top || 0) * z;
  canvas.setViewportTransform(vpt);
  canvas.requestRenderAll();
  cb.onSelectionChange?.([obj]);
}

// ─── Rebuild canvas from board data ───────────────────────────────────────────
export function rebuildCanvas(boardData) {
  if (!canvas) return;
  board = boardData;
  gridSize = board.gridSize || 10;
  snapToGrid = board.snapToGrid || false;

  // Disable perPixelTargetFind during rebuild to avoid Fabric aCoords bug
  canvas.perPixelTargetFind = false;

  // Remove all non-image objects
  canvas.getObjects().filter(o => !o.pcb || !['img'].includes(o.pcb.t)).forEach(o => canvas.remove(o));

  // Non-pin markers
  board.markers.filter(m => m.t !== 'pin').forEach(m => {
    if (m.t === 'smd') placeSMD(null, m);
    else placeMarker(null, m);
  });

  // Components
  board.components.forEach(c => {
    const b = c.bounds || { x1: 0, y1: 0, x2: 80, y2: 60 };
    board.components = board.components.filter(x => x.id !== c.id);
    buildCompOutline(b, c.id, c.label, c.compType, c.pinCount, c.value, c.layer);
  });

  // Pins
  board.markers.filter(m => m.t === 'pin').forEach(p => {
    placePin(null, p);
  });

  // Nets
  board.nets.forEach(n => {
    const f = board.markers.find(m => m.id === n.fromId);
    const t = board.markers.find(m => m.id === n.toId);
    if (f && t) buildNet(f, t, n);
  });

  // Traces
  (board.traces || []).forEach(t => {
    if (!t.points || t.points.length < 2) return;
    const col = TRACE_COLORS[t.layer] || '#44ff88';
    const pl = new fabric.Polyline([...t.points], {
      stroke: col, strokeWidth: t.width || 3, fill: 'transparent',
      selectable: currentTool === 'select', hasControls: false,
      strokeLineCap: 'round', strokeLineJoin: 'round',
    });
    pl.pcb = { ...t };
    canvas.add(pl);
  });

  // Pours
  (board.pours || []).forEach(p => { if (p.points?.length >= 3) renderPour(p); });

  // Outline
  if (board.outline?.length >= 3) {
    const pg = new fabric.Polygon([...board.outline], {
      stroke: '#fff', strokeWidth: 2, fill: 'transparent',
      strokeDashArray: [8, 4], selectable: false, evented: false,
    });
    pg.pcb = { id: 'outline_main', t: 'outline', points: board.outline };
    canvas.add(pg);
  }

  // Align points
  ['top', 'bottom'].forEach(side => {
    (board.alignPoints[side] || []).forEach((a, i) => {
      placeAlignPoint(null, { id: a.id, side, idx: i + 1, x: a.x, y: a.y });
    });
  });

  // Grid
  if (showGrid) drawGridOverlay();

  // Images go to back
  if (botImg) canvas.sendToBack(botImg);
  if (topImg) canvas.sendToBack(topImg);

  updateLayerVisibility();
  canvas.requestRenderAll();

  // Re-enable perPixelTargetFind after all objects are initialized
  requestAnimationFrame(() => {
    if (canvas) canvas.perPixelTargetFind = true;
  });
}

// ─── Sync positions back to data ──────────────────────────────────────────────
export function syncPositions() {
  canvas.getObjects().forEach(o => {
    if (!o.pcb) return;
    if (['marker', 'smd', 'pin', 'align'].includes(o.pcb.t)) {
      o.pcb.x = o.left; o.pcb.y = o.top;
    }
  });
  board.markers.forEach(m => {
    const obj = findObj(m.id);
    if (obj) { m.x = obj.left; m.y = obj.top; }
  });
  ['top', 'bottom'].forEach(side => {
    board.alignPoints[side].forEach(a => {
      const obj = findObj(a.id);
      if (obj) { a.x = obj.left; a.y = obj.top; }
    });
  });
}

// ─── Export markdown ──────────────────────────────────────────────────────────
export function exportMarkdown() {
  let md = `# PCB Mapper — ${board.boardName || 'Untitled'}\n\n`;
  if (board.boardWidth && board.boardHeight) {
    md += `Board: ${board.boardWidth}×${board.boardHeight}mm\n\n`;
  }

  md += `## Components\n| Label | Type | Pins | Value | Layer |\n|---|---|---|---|---|\n`;
  board.components.forEach(c => {
    const pinCount = board.markers.filter(m => m.t === 'pin' && m.parentId === c.id).length;
    md += `| ${c.label} | ${c.compType} | ${pinCount}/${c.pinCount} | ${c.value || '—'} | ${c.layer} |\n`;
  });

  md += `\n## Markers\n| Label | Type | Hole Size | Layer |\n|---|---|---|---|\n`;
  board.markers.filter(m => m.t !== 'pin').forEach(m => {
    md += `| ${m.label} | ${m.t === 'smd' ? 'SMD Pad' : m.markerType || m.t} | ${m.holeSize || m.padWidth || '—'} | ${m.layer} |\n`;
  });

  md += `\n## Connections\n| From | To | Type |\n|---|---|---|\n`;
  board.nets.forEach(n => {
    const f = board.markers.find(m => m.id === n.fromId);
    const t = board.markers.find(m => m.id === n.toId);
    md += `| ${f?.label || '?'} | ${t?.label || '?'} | ${n.netType} |\n`;
  });

  md += `\n## Pours\n`;
  board.pours.forEach(p => {
    md += `- **${p.label}** (${p.netType}, ${p.layer}) — ${p.points.length} pts, ${(p.cutouts || []).length} cutouts\n`;
  });

  md += `\n## Traces\n`;
  (board.traces || []).forEach((t, i) => {
    md += `- Trace ${i + 1}: ${t.points.length} pts, ${t.width}px wide, ${t.layer}\n`;
  });

  // Test data
  const tested = [...board.markers, ...board.components].filter(x => x.testData?._type);
  if (tested.length) {
    md += `\n## Test Results\n`;
    tested.forEach(item => {
      const td = item.testData;
      const status = { pass: '✅', fail: '❌', suspect: '⚠️', untested: '⬜' }[td._status] || '—';
      md += `\n### ${item.label} ${status}\n- Type: ${td._type}\n`;
      Object.entries(td).forEach(([k, v]) => { if (!k.startsWith('_') && k !== 'notes' && v) md += `- ${k}: ${v}\n`; });
      if (td.notes) md += `- Notes: ${td.notes}\n`;
    });
  }
  return md;
}

// ─── Context menu support ──────────────────────────────────────────────────────
export function getContextTarget(e) {
  // Returns the pcb object under the pointer if any
  const p = canvas.getPointer(e);
  return canvas.findTarget(e);
}

export function startNetFrom(pcbObj) {
  setTool('net');
  netStart = pcbObj;
  cb.onStatusUpdate?.(`From: ${pcbObj.label} — click destination`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function findObj(id) {
  return canvas.getObjects().find(o => o.pcb?.id === id);
}

function findLabelObj(id) {
  return canvas.getObjects().find(o => o.pcb?.lf === id);
}

// ─── Net Highlighting ─────────────────────────────────────────────────────────
let highlightedNetIds = new Set();
let highlightOverlays = [];

export function highlightNet(netId, boardData) {
  // Clear previous
  clearNetHighlight();
  if (!netId || !boardData) return;

  // Find all nets with same netType that share markers
  const net = boardData.nets.find(n => n.id === netId);
  if (!net) return;

  // Collect all marker IDs connected to this net's endpoints
  const seedIds = new Set([net.fromId, net.toId]);
  // Expand through all nets that share any endpoint
  let changed = true;
  while (changed) {
    changed = false;
    boardData.nets.forEach(n => {
      if (seedIds.has(n.fromId) || seedIds.has(n.toId)) {
        if (!seedIds.has(n.fromId)) { seedIds.add(n.fromId); changed = true; }
        if (!seedIds.has(n.toId)) { seedIds.add(n.toId); changed = true; }
      }
    });
  }

  highlightedNetIds = seedIds;

  // Highlight connected markers
  canvas.getObjects().forEach(o => {
    if (!o.pcb) return;
    if (seedIds.has(o.pcb.id)) {
      o._origStroke = o.stroke;
      o._origStrokeWidth = o.strokeWidth;
      o.set({ stroke: '#ff0', strokeWidth: 3 });
    }
  });

  // Highlight connected traces
  boardData.traces.forEach(t => {
    if (!t.points || t.points.length < 2) return;
    // Check if trace start/end is near any highlighted marker
    const first = t.points[0], last = t.points[t.points.length - 1];
    let connected = false;
    boardData.markers.forEach(m => {
      if (!seedIds.has(m.id)) return;
      if (Math.hypot(first.x - m.x, first.y - m.y) < 15 || Math.hypot(last.x - m.x, last.y - m.y) < 15) {
        connected = true;
      }
    });
    if (connected) {
      const tObj = findObj(t.id);
      if (tObj) {
        tObj._origStroke = tObj.stroke;
        tObj._origStrokeWidth = tObj.strokeWidth;
        tObj.set({ stroke: '#ff0', strokeWidth: (t.width || 9) + 4 });
      }
    }
  });

  canvas.requestRenderAll();
}

export function clearNetHighlight() {
  if (!canvas) return;
  canvas.getObjects().forEach(o => {
    if (o._origStroke !== undefined) {
      o.set({ stroke: o._origStroke, strokeWidth: o._origStrokeWidth });
      delete o._origStroke;
      delete o._origStrokeWidth;
    }
  });
  highlightedNetIds = new Set();
  canvas.requestRenderAll();
}

export { findObj, findLabelObj, updateNets, renderPour, rebuildPour, placeMarker, placeSMD, buildNet, buildCompOutline };
