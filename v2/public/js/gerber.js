/**
 * gerber.js — Production-quality Gerber RS-274X + Excellon drill export
 * for PCB Mapper v2 reverse engineering tool.
 *
 * Generates JLCPCB / PCBWay / OSH Park compatible Gerber X2 files.
 *
 * Coordinate system
 * ─────────────────
 *  • All x/y positions AND dimensional values (padWidth, padHeight,
 *    holeSize, trace.width) are in canvas PIXELS.
 *  • boardWidth / boardHeight are in mm.
 *  • Scale factor = boardWidth_mm / board_pixel_width.
 *  • Gerber format: %FSLAX36Y36*%  →  integer units = mm × 1 000 000
 *  • Y-axis is flipped (Gerber origin at bottom-left).
 *
 * @module gerber
 */

// ─── Tool metadata ────────────────────────────────────────────────────────────
const TOOL_NAME    = 'PCB-Mapper';
const TOOL_VERSION = '2.0.0';

// ─── Dimensional constants (mm) ───────────────────────────────────────────────
/** Soldermask expansion per side, mm */
const MASK_EXP_MM  = 0.05;
/** Paste shrink per side, mm (0 = identical to pad copper) */
const PASTE_SHK_MM = 0.00;
/** Annular ring for through-hole pads, mm */
const TH_RING_MM   = 0.25;
/** Annular ring for vias, mm */
const VIA_RING_MM  = 0.15;
/** Minimum drill diameter, mm */
const MIN_DRILL_MM = 0.10;
/** Maximum drill diameter, mm */
const MAX_DRILL_MM = 6.50;
/** Silk line width, mm */
const SILK_MM      = 0.12;
/** Outline line width, mm */
const OUTLINE_MM   = 0.05;
/** Thermal relief spoke width, mm */
const THERMAL_SPOKE_W_MM  = 0.30;
/** Thermal relief clearance gap outside pad ring, mm */
const THERMAL_CLR_MM      = 0.20;
/** Thermal relief spoke length beyond pad edge, mm */
const THERMAL_SPOKE_L_MM  = 0.50;

/** Gerber coordinate unit: 1 mm = 1 000 000 units (3.6 format) */
const GU = 1_000_000;

// ─── Coordinate transform ─────────────────────────────────────────────────────

/**
 * Derive pixel→mm transform from the full board data.
 * Uses outline points first; falls back to all spatial data.
 *
 * @param  {object} bd  boardData
 * @returns {{ minX, minY, pixelW, pixelH, scale, boardW, boardH }}
 */
function buildTransform(bd) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  function eat(x, y) {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < x0) x0 = x;  if (y < y0) y0 = y;
    if (x > x1) x1 = x;  if (y > y1) y1 = y;
  }

  // Outline is the authoritative boundary
  (bd.outline || []).forEach(p => eat(p.x, p.y));

  // Fall back to all placed objects so the transform is never empty
  if (!isFinite(x0)) {
    (bd.components || []).forEach(c => {
      if (c.bounds) {
        eat(c.bounds.x1, c.bounds.y1);
        eat(c.bounds.x2, c.bounds.y2);
      }
    });
    (bd.markers || []).forEach(m => eat(m.x, m.y));
    (bd.traces  || []).forEach(tr => (tr.points || []).forEach(p => eat(p.x, p.y)));
    (bd.pours   || []).forEach(po => {
      (po.points  || []).forEach(p  => eat(p.x, p.y));
      (po.cutouts || []).forEach(co => (co.points || []).forEach(p => eat(p.x, p.y)));
    });
  }

  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 100; y1 = 100; }

  const pixelW = Math.max(x1 - x0, 1);
  const pixelH = Math.max(y1 - y0, 1);
  const boardW = bd.boardWidth  || 100;
  const boardH = bd.boardHeight || boardW * (pixelH / pixelW);
  const scale  = boardW / pixelW;   // mm per pixel

  return { minX: x0, minY: y0, pixelW, pixelH, scale, boardW, boardH };
}

/**
 * Convert a canvas pixel coordinate to Gerber integer units.
 *
 * @param  {number} px  canvas X
 * @param  {number} py  canvas Y
 * @param  {object} t   transform from buildTransform()
 * @returns {{ x: number, y: number }}
 */
function p2g(px, py, t) {
  const mmX =              (px - t.minX) * t.scale;
  const mmY = t.boardH - ( (py - t.minY) * t.scale );   // flip Y
  return { x: Math.round(mmX * GU), y: Math.round(mmY * GU) };
}

/** Convert millimetres → Gerber integer units */
function mm2gu(mm) { return Math.round(mm * GU); }

/** Convert pixels → millimetres */
function px2mm(px, t) { return px * t.scale; }

// ─── Aperture registry ────────────────────────────────────────────────────────

/**
 * Deduplicating aperture set.
 * D-codes start at D10 per Gerber spec.
 */
class ApertureSet {
  constructor() {
    this._map  = new Map();  // canonical-key → D-code
    this._defs = [];         // definition strings in order
    this._next = 10;
  }

  _key(type, ...nums) {
    return type + ':' + nums.map(n => n.toFixed(6)).join(',');
  }

  _add(key, defStr) {
    const code = this._next++;
    this._map.set(key, code);
    this._defs.push(`%ADD${code}${defStr}*%`);
    return code;
  }

  /** Circular aperture — diameter in mm */
  circle(dMm) {
    const d = Math.max(0.001, +dMm);
    const k = this._key('C', d);
    return this._map.has(k) ? this._map.get(k) : this._add(k, `C,${fmm(d)}`);
  }

  /** Rectangular aperture — width × height in mm */
  rect(wMm, hMm) {
    const w = Math.max(0.001, +wMm), h = Math.max(0.001, +hMm);
    const k = this._key('R', w, h);
    return this._map.has(k) ? this._map.get(k) : this._add(k, `R,${fmm(w)}X${fmm(h)}`);
  }

  /** Oblong aperture — width × height in mm */
  oblong(wMm, hMm) {
    const w = Math.max(0.001, +wMm), h = Math.max(0.001, +hMm);
    const k = this._key('O', w, h);
    return this._map.has(k) ? this._map.get(k) : this._add(k, `O,${fmm(w)}X${fmm(h)}`);
  }

  /** All aperture definition lines as a single block */
  block() { return this._defs.join('\n'); }
}

/** Format mm value with 6 decimal places */
function fmm(v) { return (+v).toFixed(6); }

// ─── Gerber file builder ──────────────────────────────────────────────────────

/**
 * Assemble a complete Gerber RS-274X / Gerber X2 file string.
 *
 * @param {object}       bd          boardData
 * @param {string}       fileFunc    %TF.FileFunction value
 * @param {string}       polarity    'Positive' | 'Negative'
 * @param {ApertureSet}  apt
 * @param {string[]}     body        draw command lines
 * @returns {string}
 */
function buildGerber(bd, fileFunc, polarity, apt, body) {
  const name = sanitize(bd.boardName);
  const ts   = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const header = [
    `G04 Gerber RS-274X — generated by ${TOOL_NAME} v${TOOL_VERSION}*`,
    `%TF.GenerationSoftware,${TOOL_NAME},v${TOOL_VERSION},*%`,
    `%TF.CreationDate,${ts}*%`,
    `%TF.ProjectId,${name},00000000-0000-0000-0000-000000000000,rev1*%`,
    `%TF.SameCoordinates,Original*%`,
    `%TF.FileFunction,${fileFunc}*%`,
    `%TF.FilePolarity,${polarity}*%`,
    `%FSLAX36Y36*%`,
    `%MOMM*%`,
    `G04 --- Aperture Definitions ---*`,
    apt.block(),
    `G04 --- Board Data ---*`,
    `G01*`,          // linear interpolation mode (default)
  ];

  return header.join('\n') + '\n' + body.join('\n') + '\nM02*\n';
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Emit a closed polygon into body[] using G36/G37.
 * Points are canvas pixel coordinates; closing is handled automatically.
 */
function emitPolygon(body, points, t) {
  if (!points || points.length < 3) return;
  body.push('G36*');
  const fp = p2g(points[0].x, points[0].y, t);
  body.push(`X${fp.x}Y${fp.y}D02*`);
  for (let i = 1; i < points.length; i++) {
    const p = p2g(points[i].x, points[i].y, t);
    body.push(`X${p.x}Y${p.y}D01*`);
  }
  // Close — must match first point exactly
  body.push(`X${fp.x}Y${fp.y}D01*`);
  body.push('G37*');
}

/**
 * Emit a closed polygon defined by mm coordinates (absolute, already flipped).
 * Used internally for thermal relief spokes / clearance shapes.
 */
function emitPolygonMM(body, mmPoints) {
  if (!mmPoints || mmPoints.length < 3) return;
  body.push('G36*');
  const fp = mmPoints[0];
  body.push(`X${mm2gu(fp.x)}Y${mm2gu(fp.y)}D02*`);
  for (let i = 1; i < mmPoints.length; i++) {
    body.push(`X${mm2gu(mmPoints[i].x)}Y${mm2gu(mmPoints[i].y)}D01*`);
  }
  body.push(`X${mm2gu(fp.x)}Y${mm2gu(fp.y)}D01*`);
  body.push('G37*');
}

/** Ray-casting point-in-polygon (canvas pixel coords). */
function ptInPoly(px, py, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Generate 4-spoke thermal relief pattern in board-space mm coords.
 *
 * @param {number} cx  centre X in board mm
 * @param {number} cy  centre Y in board mm
 * @param {number} padR  pad outer radius in mm (includes annular ring)
 * @param {number} clr   clearance gap in mm
 * @param {number} sw    spoke width in mm
 * @param {number} sl    spoke length (beyond pad edge) in mm
 * @returns {{ clearPolygon: {x,y}[], spokes: {x,y}[][] }}
 */
function thermalRelief(cx, cy, padR, clr, sw, sl) {
  const outerR = padR + clr + sl;

  // Clearance annulus approximated as octagon for LPC region
  const N = 32;
  const clearPolygon = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    clearPolygon.push({ x: cx + Math.cos(a) * outerR, y: cy + Math.sin(a) * outerR });
  }

  // 4 rectangular spokes (±X, ±Y directions)
  const halfSW = sw / 2;
  const innerEdge = padR + clr * 0.1;  // start flush with pad ring
  const outerEdge = padR + clr + sl;

  const spokes = [
    // East
    [ { x: cx + innerEdge, y: cy - halfSW },
      { x: cx + outerEdge, y: cy - halfSW },
      { x: cx + outerEdge, y: cy + halfSW },
      { x: cx + innerEdge, y: cy + halfSW } ],
    // West
    [ { x: cx - outerEdge, y: cy - halfSW },
      { x: cx - innerEdge, y: cy - halfSW },
      { x: cx - innerEdge, y: cy + halfSW },
      { x: cx - outerEdge, y: cy + halfSW } ],
    // North (Gerber +Y = physical up)
    [ { x: cx - halfSW, y: cy + innerEdge },
      { x: cx + halfSW, y: cy + innerEdge },
      { x: cx + halfSW, y: cy + outerEdge },
      { x: cx - halfSW, y: cy + outerEdge } ],
    // South
    [ { x: cx - halfSW, y: cy - outerEdge },
      { x: cx + halfSW, y: cy - outerEdge },
      { x: cx + halfSW, y: cy - innerEdge },
      { x: cx - halfSW, y: cy - innerEdge } ],
  ];

  return { clearPolygon, spokes };
}

// ─── Layer: Copper ────────────────────────────────────────────────────────────

/**
 * Generate a copper layer (top F_Cu / bottom B_Cu).
 * Renders: traces, through-hole pads, SMD pads, vias, pour regions.
 * Thermal relief is applied to through-hole pads inside pours.
 */
function makeCopper(bd, t, side) {
  const apt  = new ApertureSet();
  const body = [];
  const isTop = side === 'top';
  const func  = isTop ? 'Copper,L1,Top' : 'Copper,L2,Bot';

  // ── 1. Traces ──────────────────────────────────────────────────────────────
  for (const tr of (bd.traces || []).filter(tr => tr.layer === side)) {
    if (!tr.points || tr.points.length < 2) continue;

    const wMm = Math.max(0.05, px2mm(tr.width || 3, t));
    const dc  = apt.circle(wMm);

    body.push(`G04 trace id=${tr.id}*`);
    body.push(`D${dc}*`);

    const p0 = p2g(tr.points[0].x, tr.points[0].y, t);
    body.push(`X${p0.x}Y${p0.y}D02*`);
    for (let i = 1; i < tr.points.length; i++) {
      const p = p2g(tr.points[i].x, tr.points[i].y, t);
      body.push(`X${p.x}Y${p.y}D01*`);
    }
  }

  // ── 2. Collect markers for this layer ──────────────────────────────────────
  const myMarkers = (bd.markers || []).filter(m => {
    if (m.t === 'marker' && m.markerType === 'via') return true;  // vias: both layers
    return m.layer === side;
  });

  // ── 3. Pads and vias ───────────────────────────────────────────────────────
  for (const m of myMarkers) {
    const gc = p2g(m.x, m.y, t);

    if (m.t === 'smd') {
      // SMD pad — rectangular copper
      const pw = Math.max(0.10, px2mm(m.padWidth  || 14, t));
      const ph = Math.max(0.10, px2mm(m.padHeight || 8,  t));
      body.push(`G04 SMD pad id=${m.id}*`);
      body.push(`D${apt.rect(pw, ph)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);

    } else if (m.t === 'marker' && m.markerType === 'via') {
      // Via — circular pad on both copper layers
      const holeMm = clamp(px2mm(m.holeSize || 6, t), MIN_DRILL_MM, MAX_DRILL_MM);
      const padMm  = holeMm + 2 * VIA_RING_MM;
      body.push(`G04 via id=${m.id}*`);
      body.push(`D${apt.circle(padMm)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);

    } else if (m.t === 'marker' && (m.markerType === 'hole' || m.markerType === 'pad')) {
      // Through-hole pad
      const holeMm = clamp(px2mm(m.holeSize || 11, t), MIN_DRILL_MM, MAX_DRILL_MM);
      const padMm  = holeMm + 2 * TH_RING_MM;
      body.push(`G04 TH pad id=${m.id} markerType=${m.markerType}*`);
      body.push(`D${apt.circle(padMm)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);

    } else if (m.t === 'pin') {
      // Component pin (through-hole)
      const holeMm = clamp(px2mm(m.holeSize || 6, t), MIN_DRILL_MM, MAX_DRILL_MM);
      const padMm  = holeMm + 2 * TH_RING_MM;
      body.push(`G04 pin id=${m.id}*`);
      body.push(`D${apt.circle(padMm)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);
    }
  }

  // ── 4. Pour regions ────────────────────────────────────────────────────────
  const pours = (bd.pours || []).filter(po => po.layer === side);

  // Collect through-hole markers that need thermal relief
  const thMarkers = myMarkers.filter(m =>
    m.t === 'marker' && (m.markerType === 'via' || m.markerType === 'hole' || m.markerType === 'pad') ||
    m.t === 'pin'
  );

  for (const pour of pours) {
    if (!pour.points || pour.points.length < 3) continue;

    body.push(`G04 pour id=${pour.id} label=${pour.label || ''}*`);
    body.push('%LPD*%');
    emitPolygon(body, pour.points, t);

    // Explicit user cutouts
    for (const co of (pour.cutouts || [])) {
      if (!co.points || co.points.length < 3) continue;
      body.push(`G04 cutout id=${co.id || '?'}*`);
      body.push('%LPC*%');
      emitPolygon(body, co.points, t);
      body.push('%LPD*%');
    }

    // ── Thermal relief for TH pads inside this pour ────────────────────────
    for (const m of thMarkers) {
      if (!ptInPoly(m.x, m.y, pour.points)) continue;

      const isVia   = m.t === 'marker' && m.markerType === 'via';
      const defHole = isVia ? 6 : 11;
      const holeMm  = clamp(px2mm(m.holeSize || defHole, t), MIN_DRILL_MM, MAX_DRILL_MM);
      const padR    = holeMm / 2 + (isVia ? VIA_RING_MM : TH_RING_MM);

      // Convert pad centre to board-space mm
      const cxMm = (m.x - t.minX) * t.scale;
      const cyMm = t.boardH - (m.y - t.minY) * t.scale;

      const { clearPolygon, spokes } = thermalRelief(
        cxMm, cyMm, padR,
        THERMAL_CLR_MM,
        THERMAL_SPOKE_W_MM,
        THERMAL_SPOKE_L_MM
      );

      body.push(`G04 thermal relief for id=${m.id}*`);

      // 1. Clear the annular relief zone
      body.push('%LPC*%');
      emitPolygonMM(body, clearPolygon);

      // 2. Add 4 copper spokes back
      body.push('%LPD*%');
      for (const spoke of spokes) {
        emitPolygonMM(body, spoke);
      }
    }

    // Restore dark polarity after pour processing
    body.push('%LPD*%');
  }

  return buildGerber(bd, func, 'Positive', apt, body);
}

// ─── Layer: Soldermask ────────────────────────────────────────────────────────

/**
 * Generate a soldermask layer (Positive — openings drawn as copper).
 * All pad apertures are expanded by MASK_EXP_MM on each side.
 */
function makeSoldermask(bd, t, side) {
  const apt  = new ApertureSet();
  const body = [];
  const func = side === 'top' ? 'Soldermask,Top' : 'Soldermask,Bot';

  const markers = (bd.markers || []).filter(m => {
    if (m.t === 'marker' && m.markerType === 'via') return true;
    return m.layer === side;
  });

  for (const m of markers) {
    const gc = p2g(m.x, m.y, t);

    if (m.t === 'smd') {
      const pw = Math.max(0.10, px2mm(m.padWidth  || 14, t)) + MASK_EXP_MM * 2;
      const ph = Math.max(0.10, px2mm(m.padHeight || 8,  t)) + MASK_EXP_MM * 2;
      body.push(`D${apt.rect(pw, ph)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);

    } else if (m.t === 'marker' && m.markerType === 'via') {
      const holeMm = clamp(px2mm(m.holeSize || 6,  t), MIN_DRILL_MM, MAX_DRILL_MM);
      const diam   = holeMm + 2 * VIA_RING_MM + MASK_EXP_MM * 2;
      body.push(`D${apt.circle(diam)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);

    } else if (m.t === 'marker' && (m.markerType === 'hole' || m.markerType === 'pad')) {
      const holeMm = clamp(px2mm(m.holeSize || 11, t), MIN_DRILL_MM, MAX_DRILL_MM);
      const diam   = holeMm + 2 * TH_RING_MM + MASK_EXP_MM * 2;
      body.push(`D${apt.circle(diam)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);

    } else if (m.t === 'pin') {
      const holeMm = clamp(px2mm(m.holeSize || 6, t), MIN_DRILL_MM, MAX_DRILL_MM);
      const diam   = holeMm + 2 * TH_RING_MM + MASK_EXP_MM * 2;
      body.push(`D${apt.circle(diam)}*`);
      body.push(`X${gc.x}Y${gc.y}D03*`);
    }
  }

  return buildGerber(bd, func, 'Positive', apt, body);
}

// ─── Layer: Solder paste ──────────────────────────────────────────────────────

/**
 * Generate a solder paste / stencil layer (SMD pads only).
 * Positive polarity — drawn areas get paste.
 */
function makePaste(bd, t, side) {
  const apt  = new ApertureSet();
  const body = [];
  const func = side === 'top' ? 'SolderPaste,Top' : 'SolderPaste,Bot';

  const smdPads = (bd.markers || []).filter(m => m.t === 'smd' && m.layer === side);

  for (const m of smdPads) {
    const gc = p2g(m.x, m.y, t);
    const pw = Math.max(0.05, px2mm(m.padWidth  || 14, t) - PASTE_SHK_MM * 2);
    const ph = Math.max(0.05, px2mm(m.padHeight || 8,  t) - PASTE_SHK_MM * 2);
    body.push(`D${apt.rect(pw, ph)}*`);
    body.push(`X${gc.x}Y${gc.y}D03*`);
  }

  return buildGerber(bd, func, 'Positive', apt, body);
}

// ─── Layer: Silkscreen ────────────────────────────────────────────────────────

/**
 * Generate a silkscreen / legend layer.
 * Draws component body outlines with a pin-1 corner indicator.
 */
function makeSilkscreen(bd, t, side) {
  const apt  = new ApertureSet();
  const body = [];
  const func = side === 'top' ? 'Legend,Top' : 'Legend,Bot';

  const dc = apt.circle(SILK_MM);
  body.push(`D${dc}*`);

  for (const comp of (bd.components || []).filter(c => c.layer === side)) {
    if (!comp.bounds) continue;
    const { x1, y1, x2, y2 } = comp.bounds;

    const tl = p2g(x1, y1, t);
    const tr = p2g(x2, y1, t);
    const br = p2g(x2, y2, t);
    const bl = p2g(x1, y2, t);

    body.push(`G04 comp ${comp.label || comp.id}*`);

    // Outer rectangle — leave a gap at the top-left for pin-1 indicator
    const gap = mm2gu(1.0);   // 1 mm notch gap

    // Bottom edge  (bl → br)
    body.push(`X${bl.x}Y${bl.y}D02*`);
    body.push(`X${br.x}Y${br.y}D01*`);
    // Right edge   (br → tr)
    body.push(`X${tr.x}Y${tr.y}D01*`);
    // Top edge with notch: tr → (tl + gap) — skip gap — (tl + gap, tl)
    const notchEnd = tl.x + gap;
    body.push(`X${notchEnd}Y${tr.y}D01*`);   // top right portion, stop before notch
    // Resume after notch
    body.push(`X${tl.x}Y${tl.y + gap}D02*`); // jump to below pin-1 notch
    body.push(`X${tl.x}Y${bl.y}D01*`);       // left edge down
  }

  return buildGerber(bd, func, 'Positive', apt, body);
}

// ─── Layer: Board outline ─────────────────────────────────────────────────────

/**
 * Generate board edge cuts / mechanical outline layer.
 */
function makeOutline(bd, t) {
  const apt  = new ApertureSet();
  const body = [];

  const dc = apt.circle(OUTLINE_MM);
  body.push(`D${dc}*`);

  const pts = bd.outline;
  if (pts && pts.length >= 2) {
    const fp = p2g(pts[0].x, pts[0].y, t);
    body.push(`X${fp.x}Y${fp.y}D02*`);
    for (let i = 1; i < pts.length; i++) {
      const p = p2g(pts[i].x, pts[i].y, t);
      body.push(`X${p.x}Y${p.y}D01*`);
    }
    // Close if not already
    const lp = pts[pts.length - 1];
    if (lp.x !== pts[0].x || lp.y !== pts[0].y) {
      body.push(`X${fp.x}Y${fp.y}D01*`);
    }
  } else {
    // Fallback: axis-aligned rectangle from boardW × boardH
    const bw = mm2gu(t.boardW);
    const bh = mm2gu(t.boardH);
    body.push(`X0Y0D02*`);
    body.push(`X${bw}Y0D01*`);
    body.push(`X${bw}Y${bh}D01*`);
    body.push(`X0Y${bh}D01*`);
    body.push(`X0Y0D01*`);
  }

  return buildGerber(bd, 'Profile,NP', 'Positive', apt, body);
}

// ─── Excellon drill file ──────────────────────────────────────────────────────

/**
 * Generate Excellon FMAT,2 metric drill file with plated through-holes.
 */
function makeDrill(bd, t) {
  const lines = [];

  // Collect all drillable markers
  const drillable = (bd.markers || []).filter(m =>
    (m.t === 'marker' && (m.markerType === 'via' || m.markerType === 'hole' || m.markerType === 'pad')) ||
    m.t === 'pin'
  );

  // Group by size
  const toolMap = new Map();  // sizeMm (3 dp) → [{mmX, mmY}]
  for (const m of drillable) {
    const defPx  = (m.t === 'marker' && m.markerType === 'via') ? 6 : 11;
    const holeMm = clamp(px2mm(m.holeSize || defPx, t), MIN_DRILL_MM, MAX_DRILL_MM);
    const key    = parseFloat(holeMm.toFixed(3));
    if (!toolMap.has(key)) toolMap.set(key, []);

    const mmX = (m.x - t.minX) * t.scale;
    const mmY = t.boardH - (m.y - t.minY) * t.scale;   // flip Y
    toolMap.get(key).push({ mmX, mmY });
  }

  const sortedTools = [...toolMap.entries()].sort((a, b) => a[0] - b[0]);

  // ── Header ──
  lines.push('M48');
  lines.push(`; Excellon drill data — generated by ${TOOL_NAME} v${TOOL_VERSION}`);
  lines.push(`; Board: ${bd.boardName || 'Untitled'}`);
  lines.push(`; Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`; Layer_count: 2`);
  lines.push(`; Drill_method: Conventional`);
  lines.push('FMAT,2');
  lines.push('METRIC,TZ');   // metric, trailing zeros suppressed

  // ── Tool table ──
  sortedTools.forEach(([size], idx) => {
    lines.push(`T${tnum(idx + 1)}C${size.toFixed(3)}`);
  });

  lines.push('%');
  lines.push('G90');   // absolute
  lines.push('G05');   // drill mode

  // ── Hole data ──
  sortedTools.forEach(([size, holes], idx) => {
    lines.push(`T${tnum(idx + 1)}`);
    for (const { mmX, mmY } of holes) {
      lines.push(`X${mmX.toFixed(3)}Y${mmY.toFixed(3)}`);
    }
  });

  lines.push('T00');   // deselect all tools
  lines.push('M30');   // end of program

  return lines.join('\n') + '\n';
}

// ─── Pick and place / centroid ────────────────────────────────────────────────

/**
 * Generate IPC-7711/7721 centroid / pick-and-place CSV.
 */
function makePnP(bd, t) {
  const lines = [];
  lines.push(`# Pick and Place — ${bd.boardName || 'Untitled'}`);
  lines.push(`# Generated by: ${TOOL_NAME} v${TOOL_VERSION}`);
  lines.push(`# Date: ${new Date().toISOString()}`);
  lines.push(`# Units: mm  Angle: degrees CCW`);
  lines.push('#');
  lines.push('Ref,Value,Package,PosX,PosY,Rotation,Side');

  for (const comp of (bd.components || [])) {
    if (!comp.bounds) continue;
    const cx   = (comp.bounds.x1 + comp.bounds.x2) / 2;
    const cy   = (comp.bounds.y1 + comp.bounds.y2) / 2;
    const mmX  = (cx - t.minX) * t.scale;
    const mmY  = t.boardH - (cy - t.minY) * t.scale;
    const ref  = comp.label    || comp.id;
    const val  = comp.value    || '';
    const pkg  = comp.compType || 'Unknown';
    const side = comp.layer === 'bottom' ? 'B' : 'T';
    lines.push(`${ref},${val},${pkg},${mmX.toFixed(4)},${mmY.toFixed(4)},0.0,${side}`);
  }

  return lines.join('\n') + '\n';
}

// ─── README ───────────────────────────────────────────────────────────────────

function makeReadme(bd, name) {
  const bw = (bd.boardWidth  || 0).toFixed(2);
  const bh = (bd.boardHeight || 0).toFixed(2);
  return [
    `Gerber RS-274X / Excellon Drill Package`,
    `Generated by: ${TOOL_NAME} v${TOOL_VERSION}`,
    `Date: ${new Date().toISOString()}`,
    ``,
    `Board  : ${bd.boardName || 'Unknown'}`,
    `Size   : ${bw} × ${bh} mm`,
    ``,
    `Files`,
    `─────`,
    `  ${name}-F_Cu.gtl          Front copper (Gerber X2)`,
    `  ${name}-B_Cu.gbl          Back copper  (Gerber X2)`,
    `  ${name}-F_Mask.gts        Front soldermask (Gerber X2)`,
    `  ${name}-B_Mask.gbs        Back soldermask  (Gerber X2)`,
    `  ${name}-F_Paste.gtp       Front solder paste (Gerber X2)`,
    `  ${name}-B_Paste.gbp       Back solder paste  (Gerber X2)`,
    `  ${name}-F_Silkscreen.gto  Front silkscreen (Gerber X2)`,
    `  ${name}-B_Silkscreen.gbo  Back silkscreen  (Gerber X2)`,
    `  ${name}-Edge_Cuts.gko     Board outline    (Gerber X2)`,
    `  ${name}-PTH.drl           Plated through-holes (Excellon)`,
    `  ${name}-PnP.csv           Pick & place centroid data`,
    ``,
    `Format : Gerber 3.6, metric (mm), absolute coordinates, Y-up`,
    `Compat : JLCPCB · PCBWay · OSH Park · Eurocircuits · AISLER`,
    ``,
    `IMPORTANT`,
    `─────────`,
    `This file set was reverse-engineered from PCB imagery.`,
    `Verify all pad sizes, hole diameters, and connectivity against`,
    `component datasheets before submitting to a fabrication house.`,
  ].join('\n') + '\n';
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Export board data to a complete Gerber RS-274X + Excellon package.
 *
 * @param  {object}  boardData           PCB board data object
 * @param  {object}  [options={}]
 * @param  {boolean} [options.includePnP=true]     Include pick-and-place CSV
 * @param  {boolean} [options.includeReadme=true]  Include README.txt
 * @returns {Promise<JSZip>}  JSZip instance (use .generateAsync() to download)
 *
 * @example
 *   const zip = await exportGerber(boardData);
 *   const blob = await zip.generateAsync({ type: 'blob' });
 *   saveAs(blob, `${boardData.boardName}.zip`);
 */
export async function exportGerber(boardData, options = {}) {
  const {
    includePnP    = true,
    includeReadme = true,
  } = options;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!boardData || typeof boardData !== 'object') {
    throw new TypeError('boardData must be a non-null object');
  }
  if (!(boardData.boardWidth > 0)) {
    throw new RangeError('boardData.boardWidth must be a positive number (mm)');
  }

  const t    = buildTransform(boardData);
  const name = sanitize(boardData.boardName);

  // ── Generate all layers ─────────────────────────────────────────────────────
  const files = {
    [`${name}-F_Cu.gtl`]:          makeCopper(boardData, t, 'top'),
    [`${name}-B_Cu.gbl`]:          makeCopper(boardData, t, 'bottom'),
    [`${name}-F_Mask.gts`]:        makeSoldermask(boardData, t, 'top'),
    [`${name}-B_Mask.gbs`]:        makeSoldermask(boardData, t, 'bottom'),
    [`${name}-F_Paste.gtp`]:       makePaste(boardData, t, 'top'),
    [`${name}-B_Paste.gbp`]:       makePaste(boardData, t, 'bottom'),
    [`${name}-F_Silkscreen.gto`]:  makeSilkscreen(boardData, t, 'top'),
    [`${name}-B_Silkscreen.gbo`]:  makeSilkscreen(boardData, t, 'bottom'),
    [`${name}-Edge_Cuts.gko`]:     makeOutline(boardData, t),
    [`${name}-PTH.drl`]:           makeDrill(boardData, t),
  };

  if (includePnP)    files[`${name}-PnP.csv`]    = makePnP(boardData, t);
  if (includeReadme) files[`README.txt`]          = makeReadme(boardData, name);

  // ── Package into JSZip ──────────────────────────────────────────────────────
  let JSZipClass;
  /* global JSZip */
  if (typeof JSZip !== 'undefined') {
    JSZipClass = JSZip;
  } else {
    try {
      const mod = await import('jszip');
      JSZipClass = mod.default ?? mod;
    } catch {
      throw new Error(
        'JSZip is not available. Load it via <script src="jszip.min.js"> ' +
        'or npm install jszip before calling exportGerber().'
      );
    }
  }

  const zip    = new JSZipClass();
  const folder = zip.folder(name);

  for (const [filename, content] of Object.entries(files)) {
    folder.file(filename, content);
  }

  return zip;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a Gerber RS-274X file string.
 *
 * Checks:
 *  • Required structural elements (%FSLAX, %MO, M02*)
 *  • Gerber X2 attributes (%TF.FileFunction, %TF.FilePolarity, …)
 *  • Balanced G36/G37 polygon regions
 *  • Aperture definitions vs. usage
 *  • Plausible coordinate range
 *
 * @param  {string} gerberString
 * @returns {{ valid: boolean, errors: string[], warnings: string[], stats: object }}
 */
export function validateGerber(gerberString) {
  const errors   = [];
  const warnings = [];

  if (typeof gerberString !== 'string' || !gerberString.trim()) {
    return { valid: false, errors: ['Input must be a non-empty string'], warnings: [], stats: {} };
  }

  // ── Required structural elements ──────────────────────────────────────────
  if (!/^%FSLAX\d{2}Y\d{2}\*%/m.test(gerberString)) {
    errors.push('Missing or malformed coordinate format specification (%FSLAX36Y36*%)');
  }

  if (!/%MO(MM|IN)\*%/.test(gerberString)) {
    errors.push('Missing unit specification (%MOMM*% or %MOIN*%)');
  }

  if (!gerberString.includes('M02*')) {
    errors.push('Missing end-of-program code (M02*)');
  }

  // ── Gerber X2 attributes ──────────────────────────────────────────────────
  if (!gerberString.includes('%TF.GenerationSoftware')) {
    warnings.push('Missing %TF.GenerationSoftware (recommended for traceability)');
  }
  if (!gerberString.includes('%TF.FileFunction')) {
    warnings.push('Missing %TF.FileFunction (required by JLCPCB/PCBWay DFM check)');
  }
  if (!gerberString.includes('%TF.FilePolarity')) {
    warnings.push('Missing %TF.FilePolarity (required by JLCPCB/PCBWay DFM check)');
  }
  if (!gerberString.includes('%TF.CreationDate')) {
    warnings.push('Missing %TF.CreationDate');
  }
  if (!gerberString.includes('%TF.ProjectId')) {
    warnings.push('Missing %TF.ProjectId');
  }

  // ── Aperture definitions ──────────────────────────────────────────────────
  const definedCodes = new Set();
  for (const m of gerberString.matchAll(/%ADD(\d+)/g)) {
    definedCodes.add(parseInt(m[1], 10));
  }
  if (definedCodes.size === 0) {
    warnings.push('No aperture definitions (%ADD…) found — file may contain no copper');
  }

  // ── Aperture usage ────────────────────────────────────────────────────────
  const usedCodes = new Set();
  for (const m of gerberString.matchAll(/\bD(\d{2,})\*/g)) {
    const code = parseInt(m[1], 10);
    if (code >= 10) usedCodes.add(code);
  }
  for (const code of usedCodes) {
    if (!definedCodes.has(code)) {
      errors.push(`Aperture D${code} is used but never defined`);
    }
  }

  // ── G36/G37 polygon balance ────────────────────────────────────────────────
  const g36n = (gerberString.match(/G36\*/g) || []).length;
  const g37n = (gerberString.match(/G37\*/g) || []).length;
  if (g36n !== g37n) {
    errors.push(`Unbalanced polygon regions: ${g36n}× G36* vs ${g37n}× G37*`);
  }

  // ── Layer polarity balance ────────────────────────────────────────────────
  const lpdN = (gerberString.match(/%LPD\*%/g) || []).length;
  const lpcN = (gerberString.match(/%LPC\*%/g) || []).length;
  if (lpcN > lpdN) {
    warnings.push(`More %LPC*% (clear) than %LPD*% (dark) polarity commands`);
  }

  // ── Coordinate range sanity ───────────────────────────────────────────────
  let coordCount = 0;
  let rangeViolation = false;
  for (const m of gerberString.matchAll(/X(-?\d+)Y(-?\d+)/g)) {
    coordCount++;
    if (!rangeViolation) {
      const mmX = parseInt(m[1], 10) / GU;
      const mmY = parseInt(m[2], 10) / GU;
      if (mmX < -1500 || mmX > 1500 || mmY < -1500 || mmY > 1500) {
        errors.push(
          `Coordinate out of plausible PCB range: X=${mmX.toFixed(3)} Y=${mmY.toFixed(3)} mm`
        );
        rangeViolation = true;
      }
    }
  }

  if (coordCount === 0) {
    warnings.push('No XY coordinate commands found (file may be empty or contain only aperture defs)');
  }

  // ── Draw commands check ───────────────────────────────────────────────────
  const d01n = (gerberString.match(/D01\*/g) || []).length;
  const d03n = (gerberString.match(/D03\*/g) || []).length;
  if (d01n === 0 && d03n === 0) {
    warnings.push('No D01 (draw) or D03 (flash) commands — nothing will be drawn');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      coordCount,
      aperturesDefined: definedCodes.size,
      aperturesUsed:    usedCodes.size,
      polygonRegions:   g36n,
      drawCmds:         d01n,
      flashCmds:        d03n,
    },
  };
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function sanitize(name) {
  return (name || 'PCB')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'PCB';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Zero-padded tool number string (T01, T02, …) */
function tnum(n) {
  return String(n).padStart(2, '0');
}
