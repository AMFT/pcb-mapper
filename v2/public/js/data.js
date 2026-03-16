/**
 * PCB Mapper v2 — Data Model
 * Pure data manipulation. No DOM, no canvas. All items keyed by id.
 */

export function createBoard(name = 'Untitled', widthMM = 0, heightMM = 0) {
  return {
    boardName: name,
    boardWidth: widthMM,
    boardHeight: heightMM,
    components: [],
    markers: [],    // includes via, hole, smd, pin, pad, align
    nets: [],
    traces: [],
    pours: [],
    alignPoints: { top: [], bottom: [] },
    outline: [],
    idCounter: 1,
    gridSize: 10,
    snapToGrid: false,
    units: 'mm',
    layers: {
      topCopper: true,
      bottomCopper: true,
      topMask: true,
      bottomMask: true,
      topSilk: true,
      bottomSilk: true,
      outline: true,
      drills: true,
    },
  };
}

export function genId(board) {
  return 'o' + (board.idCounter++);
}

export function addComponent(board, { label = 'U?', compType = 'ic', pinCount = 2, value = '', layer = 'top', bounds = null } = {}) {
  const id = genId(board);
  const item = {
    id, t: 'component',
    label, compType, pinCount, value, layer,
    bounds: bounds || { x1: 0, y1: 0, x2: 80, y2: 60 },
    testData: null,
  };
  board.components.push(item);
  return item;
}

export function addMarker(board, { x = 0, y = 0, label = '', markerType = 'via', layer = 'top', holeSize = null } = {}) {
  const id = genId(board);
  const defaultSize = markerType === 'hole' ? 11 : markerType === 'via' ? 6 : 3;
  const item = {
    id, t: 'marker',
    label: label || ('V' + id.replace('o', '')),
    markerType, layer, x, y,
    holeSize: holeSize !== null ? holeSize : defaultSize,
    testData: null,
  };
  board.markers.push(item);
  return item;
}

export function addSMDPad(board, { x = 0, y = 0, label = '', layer = 'top', padWidth = 14, padHeight = 8 } = {}) {
  const id = genId(board);
  const item = {
    id, t: 'smd',
    label: label || ('P' + id.replace('o', '')),
    layer, x, y, padWidth, padHeight,
    testData: null,
  };
  board.markers.push(item);
  return item;
}

export function addPin(board, { x = 0, y = 0, label = '', parentId = null, pinNum = 1, layer = 'top' } = {}) {
  const id = parentId ? `${parentId}_p${pinNum}` : genId(board);
  const item = {
    id, t: 'pin',
    label: label || (pinNum.toString()),
    parentId, pinNum, layer, x, y,
    testData: null,
  };
  board.markers.push(item);
  return item;
}

export function addTrace(board, { points = [], layer = 'top', width = 3 } = {}) {
  const id = genId(board);
  const item = { id, t: 'trace', points: [...points], layer, width };
  board.traces.push(item);
  return item;
}

export function addPour(board, { points = [], layer = 'top', label = 'Pour', netType = 'ground', color = '#888888', opacity = 0.25 } = {}) {
  const id = genId(board);
  const item = {
    id, t: 'pour',
    points: [...points], layer, label, netType, color, opacity,
    cutouts: [],
  };
  board.pours.push(item);
  return item;
}

export function addPunchout(board, pourId, { points = [] } = {}) {
  const pour = board.pours.find(p => p.id === pourId);
  if (!pour) return null;
  const id = genId(board);
  const cutout = { id, points: [...points] };
  pour.cutouts.push(cutout);
  return cutout;
}

export function addNet(board, { fromId, toId, netType = 'signal', label = '' } = {}) {
  const id = genId(board);
  const item = { id, t: 'net', fromId, toId, netType, label };
  board.nets.push(item);
  return item;
}

export function setOutline(board, points) {
  board.outline = [...points];
}

export function addAlignPoint(board, side, { x = 0, y = 0 } = {}) {
  const pts = board.alignPoints[side];
  const idx = pts.length + 1;
  const id = `al_${side[0]}_${idx}`;
  const item = { id, x, y };
  pts.push(item);
  return item;
}

export function deleteItem(board, id) {
  // Remove component + its pins
  const compIdx = board.components.findIndex(c => c.id === id);
  if (compIdx !== -1) {
    board.components.splice(compIdx, 1);
    board.markers = board.markers.filter(m => !(m.t === 'pin' && m.parentId === id));
    board.nets = board.nets.filter(n => {
      const pin = board.markers.find(m => m.id === n.fromId || m.id === n.toId);
      return !(board.markers.find(m => m.id === n.fromId && m.parentId === id) ||
               board.markers.find(m => m.id === n.toId && m.parentId === id));
    });
    return true;
  }
  // Remove marker
  const mIdx = board.markers.findIndex(m => m.id === id);
  if (mIdx !== -1) {
    board.markers.splice(mIdx, 1);
    board.nets = board.nets.filter(n => n.fromId !== id && n.toId !== id);
    return true;
  }
  // Remove net
  const nIdx = board.nets.findIndex(n => n.id === id);
  if (nIdx !== -1) { board.nets.splice(nIdx, 1); return true; }
  // Remove trace
  const tIdx = board.traces.findIndex(t => t.id === id);
  if (tIdx !== -1) { board.traces.splice(tIdx, 1); return true; }
  // Remove pour (and its cutouts die with it)
  const pIdx = board.pours.findIndex(p => p.id === id);
  if (pIdx !== -1) { board.pours.splice(pIdx, 1); return true; }
  // Remove align point
  for (const side of ['top', 'bottom']) {
    const aIdx = board.alignPoints[side].findIndex(a => a.id === id);
    if (aIdx !== -1) { board.alignPoints[side].splice(aIdx, 1); return true; }
  }
  return false;
}

export function findItem(board, id) {
  return board.components.find(c => c.id === id)
    || board.markers.find(m => m.id === id)
    || board.nets.find(n => n.id === id)
    || board.traces.find(t => t.id === id)
    || board.pours.find(p => p.id === id)
    || board.alignPoints.top.find(a => a.id === id)
    || board.alignPoints.bottom.find(a => a.id === id)
    || null;
}

export function serialize(board) {
  return JSON.parse(JSON.stringify(board));
}

export function deserialize(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  const board = createBoard(raw.boardName, raw.boardWidth, raw.boardHeight);
  board.idCounter = raw.idCounter || 1;
  board.gridSize = raw.gridSize || 10;
  board.snapToGrid = raw.snapToGrid || false;
  board.units = raw.units || 'mm';
  board.layers = { ...board.layers, ...(raw.layers || {}) };
  board.components = (raw.components || []).map(c => ({ ...c, t: 'component' }));
  board.markers = (raw.markers || []).map(m => ({ ...m, t: m.t || m.type || 'marker' }));
  // Deduplicate markers by id
  const seen = new Set();
  board.markers = board.markers.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  board.nets = (raw.nets || []).map(n => ({ ...n, t: 'net' }));
  board.traces = (raw.traces || []).map(t => ({ ...t, t: 'trace', layer: t.layer || 'top' }));
  board.pours = (raw.pours || []).map(p => ({
    ...p, t: 'pour',
    layer: p.layer || 'top',
    color: p.color || NET_COLORS[p.netType] || '#888888',
    opacity: p.opacity || 0.25,
    cutouts: p.cutouts || [],
  }));
  board.alignPoints = { top: [], bottom: [] };
  if (raw.alignPoints) {
    board.alignPoints.top = (raw.alignPoints.top || []);
    board.alignPoints.bottom = (raw.alignPoints.bottom || []);
  }
  board.outline = raw.outline || [];
  return board;
}

// Color constants (used by deserialize)
const NET_COLORS = { power: '#ff4444', ground: '#888888', signal: '#4488ff', other: '#44cc44' };
