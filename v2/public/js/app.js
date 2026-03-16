/**
 * PCB Mapper v2 — App Orchestrator
 * Bridges the toolbar event bus to canvas engine, data model, and APIs.
 * toolbar.js owns all UI wiring; this file owns all business logic.
 */

import {
  initCanvas, setTool, setLayer, loadBoardImage, applyAlignment, flipBottom,
  zoomToFit, setZoom, getZoom, undo, redo, setGridVisible, setSnapToGrid,
  syncPositions, rebuildCanvas, selectItem, exportMarkdown,
  confirmComponent, confirmPour, deleteById, startNetFrom, getCanvasInstance,
  highlightNet, clearNetHighlight, setMarkerType,
} from './canvas.js';

import {
  createBoard, serialize, deserialize,
} from './data.js';

import {
  initApp, on, showToast, setZoomDisplay, setBoardName, setCursorPosition,
  setSelectionInfo, setAutoSaveState, renderRecentBoards, updatePartsPanel,
  switchPanelTab,
} from './toolbar.js';

import { exportGerber } from './gerber.js';
import { openGerberPreview, closeGerberPreview } from './gerber-preview.js';
import { analyzeBoard, generateHeatmap, getSuggestions, acceptSuggestion, rejectSuggestion, clearSuggestions } from './trace-suggest.js';
import { open3DViewer, close3DViewer } from './viewer3d.js';
import { initDecoders } from './decoders.js';

// ─── State ─────────────────────────────────────────────────────────────────────
let board = null;
let projectName = null;
let autoSaveTimer = null;
let canvasReady = false;
const API = '/api/projects';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Init toolbar UI (menus, panels, shortcuts)
  try { initApp(); } catch (e) { console.warn('Toolbar init partial:', e); }

  // Init component decoders in resistor panel
  const resTab = document.getElementById('tab-resistor');
  if (resTab) initDecoders(resTab, resTab);

  // Show landing page
  _showLanding();

  // Load recent boards from server
  await _loadRecentBoards();

  // Wire all toolbar events to canvas/data operations
  _wireEvents();

  // Wire tool buttons (HTML onclick)
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.addEventListener('click', () => {
      const tool = b.dataset.tool;
      if (tool && canvasReady) {
        setTool(tool);
        document.querySelectorAll('.tool-btn').forEach(x => x.classList.toggle('active', x.dataset.tool === tool));
        document.getElementById('st-tool').textContent = tool[0].toUpperCase() + tool.slice(1);
      }
    });
  });

  // Wire panel tabs
  document.querySelectorAll('.ptab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.ptab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.pcontent').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const tabEl = document.getElementById('tab-' + t.dataset.tab);
      if (tabEl) tabEl.classList.add('active');
    });
  });
});

// ─── Recent boards ────────────────────────────────────────────────────────────
async function _loadRecentBoards() {
  let boards = [];
  try {
    const projects = await _apiGet(API);
    boards = projects.map(p => ({
      path: p.name,
      name: p.boardName || p.name,
      date: p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '—',
      components: p.components || 0,
      markers: p.markers || 0,
      dims: p.boardWidth && p.boardHeight ? `${p.boardWidth}×${p.boardHeight}mm` : '',
    }));
  } catch {
    // Server not available — try localStorage
    try {
      boards = JSON.parse(localStorage.getItem('pcbmapper-recent') || '[]');
    } catch { /* empty */ }
  }

  // Try toolbar.js renderRecentBoards, but also render directly into HTML
  try { renderRecentBoards(boards); } catch { /* toolbar version may fail */ }

  // Direct render into the HTML's #recent-list
  const list = document.getElementById('recent-list');
  if (!list) return;
  if (!boards.length) {
    list.innerHTML = '<li style="color:#555;cursor:default;border:none;background:none">No recent boards</li>';
    return;
  }
  list.innerHTML = boards.map(b => `
    <li data-path="${_esc(b.path)}">
      <div>
        <div class="board-name">${_esc(b.name)}</div>
        <div class="board-meta">${b.dims ? b.dims + ' · ' : ''}${b.components} components · ${b.markers} markers · ${b.date}</div>
      </div>
    </li>
  `).join('');
  list.querySelectorAll('li[data-path]').forEach(li => {
    li.addEventListener('click', async () => {
      const path = li.dataset.path;
      try {
        const data = await _apiGet(`${API}/${path}`);
        board = deserialize(data);
        projectName = path;
        _hideElement('landing');
        _initCanvasForBoard(board);
        showToast(`Opened "${board.boardName}"`, 'success');
      } catch (e) {
        showToast('Failed to open: ' + e.message, 'error');
      }
    });
  });
}

// ─── Canvas init ──────────────────────────────────────────────────────────────
function _initCanvasForBoard(boardData) {
  board = boardData;
  canvasReady = false;
  initCanvas('board-canvas', board, {
    onToolChange: (event, data) => {
      if (event === 'component:bounds') {
        // Show the component modal
        const modal = document.getElementById('comp-modal');
        if (modal) modal.style.display = 'flex';
        setTimeout(() => document.getElementById('cm-label')?.focus(), 100);
      } else if (event === 'component:pinplace') {
        const banner = document.getElementById('pin-banner');
        const bannerText = document.getElementById('pin-banner-text');
        if (banner && bannerText) {
          bannerText.textContent = `${data.label}: Place pin ${data.startNum + data.placed} (${data.placed}/${data.pinCount} done)`;
          banner.style.display = 'block';
        }
      } else if (event === 'component:done' || event === 'component:cancelled') {
        const banner = document.getElementById('pin-banner');
        if (banner) banner.style.display = 'none';
        _afterMutation();
      } else if (event === 'pour:confirm') {
        // Show the pour modal
        const modal = document.getElementById('pour-modal');
        if (modal) modal.style.display = 'flex';
        setTimeout(() => document.getElementById('pm-label')?.focus(), 100);
      }
    },
    onSelectionChange: (selected) => {
      // Clear net highlight when clicking elsewhere
      clearNetHighlight();
      document.querySelectorAll('#cl-net li.highlighted').forEach(x => x.classList.remove('highlighted'));

      if (!selected || !selected.length) {
        setSelectionInfo('');
        const propsEl = document.getElementById('props');
        if (propsEl) propsEl.innerHTML = '<p style="color:#666">Select an element</p>';
        return;
      }
      const obj = selected[0];
      if (obj?.pcb) {
        setSelectionInfo(`${obj.pcb.t} — ${obj.pcb.label || obj.pcb.id}`);
        _renderProps(obj);
      }
    },
    onDataChange: (updatedBoard) => {
      board = updatedBoard;
      _afterMutation();
    },
    onStatusUpdate: (msg) => {
      const st = document.getElementById('st-info');
      if (st) st.textContent = msg || 'Ready';
      const stTool = document.getElementById('st-tool');
      if (stTool && !msg?.includes(',')) stTool.textContent = '';
    },
  });

  canvasReady = true;
  window._fabricCanvas = getCanvasInstance();
  window._board = board;
  try { setBoardName(board.boardName || 'Untitled'); } catch { /* toolbar may not have this */ }
  const nameEl = document.getElementById('menu-board-name');
  if (nameEl) nameEl.textContent = board.boardName || 'Untitled';
  _refreshPartsPanel();

  // Canvas mouse move → cursor position in status bar
  const canvasEl = document.getElementById('board-canvas');
  if (canvasEl) {
    canvasEl.addEventListener('mousemove', () => {
      const z = getZoom();
      setZoomDisplay(Math.round(z * 100));
    });
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function _wireEvents() {

  // ── New board ──────────────────────────────────────────────────────────────
  on('newBoard', async (data) => {
    board = createBoard(data.name, data.w || 0, data.h || 0);
    projectName = _slugify(data.name) + '_' + Date.now();
    _hideElement('landing');
    _initCanvasForBoard(board);
    showToast(`Board "${data.name}" created`, 'success');
    _saveToServer();
    // Show tutorial on first board
    const tutorial = document.getElementById('tutorial-toast');
    if (tutorial) tutorial.style.display = 'block';
  });

  // ── Open recent board ─────────────────────────────────────────────────────
  on('openRecentBoard', async ({ path }) => {
    try {
      const data = await _apiGet(`${API}/${path}`);
      board = deserialize(data);
      projectName = path;
      _hideElement('landing');
      _initCanvasForBoard(board);
      // Load server images
      const list = await _apiGet(API).catch(() => []);
      const meta = list.find(p => p.name === path);
      if (meta?.hasTopImage) await loadBoardImage('top', `${API}/${path}/images/top?t=${Date.now()}`);
      if (meta?.hasBottomImage) await loadBoardImage('bottom', `${API}/${path}/images/bottom?t=${Date.now()}`);
      showToast(`Opened "${board.boardName}"`, 'success');
    } catch (err) {
      showToast('Failed to open: ' + err.message, 'error');
    }
  });

  // ── File open (drag/drop or picker) ───────────────────────────────────────
  on('fileOpen', async ({ file }) => {
    if (!file) return;
    _hideElement('landing');
    try {
      if (file.name.match(/\.(json|pcbm|zip)$/i)) {
        await _loadFromFile(file);
      } else if (file.type.startsWith('image/')) {
        // Image drop — start new board and load as top image
        board = createBoard('New Board');
        projectName = 'board_' + Date.now();
        _initCanvasForBoard(board);
        const reader = new FileReader();
        reader.onload = async ev => { await loadBoardImage('top', ev.target.result); };
        reader.readAsDataURL(file);
      } else {
        showToast('Unsupported file type', 'error');
      }
    } catch (err) {
      showToast('Error opening file: ' + err.message, 'error');
    }
  });

  // ── Tool change ────────────────────────────────────────────────────────────
  on('toolChange', ({ tool }) => {
    if (!canvasReady) return;
    const toolMap = { select: 'select', pan: 'pan', marker: 'marker', component: 'component',
      smd: 'smd', net: 'net', trace: 'trace', pour: 'pour', punchout: 'punchout',
      outline: 'outline', align: 'align', measure: 'measure' };
    if (toolMap[tool]) setTool(toolMap[tool]);
    const stTool = document.getElementById('st-tool');
    if (stTool) stTool.textContent = tool[0].toUpperCase() + tool.slice(1);
    // Show/hide marker type bar
    const mtBar = document.getElementById('marker-type-bar');
    if (mtBar) mtBar.style.display = tool === 'marker' ? 'flex' : 'none';
  });

  // ── Layer change ───────────────────────────────────────────────────────────
  on('layerChange', ({ layer }) => {
    if (!canvasReady) return;
    setLayer(layer);
  });

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  on('undo', () => { if (!canvasReady) return; undo(); _afterMutation(); });
  on('redo', () => { if (!canvasReady) return; redo(); _afterMutation(); });

  // ── Delete ─────────────────────────────────────────────────────────────────
  on('deleteSelected', () => {
    if (!canvasReady) return;
    const canvas = getCanvasInstance();
    if (!canvas) return;
    const active = canvas.getActiveObjects();
    active.forEach(o => { if (o.pcb?.id) deleteById(o.pcb.id); });
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    _afterMutation();
  });

  // ── Zoom ───────────────────────────────────────────────────────────────────
  on('zoom', ({ delta }) => {
    if (!canvasReady) return;
    const newZ = Math.min(Math.max(getZoom() + delta * getZoom(), 0.05), 30);
    setZoom(newZ);
    setZoomDisplay(Math.round(newZ * 100));
  });
  on('zoomFit', () => { if (!canvasReady) return; zoomToFit(); setZoomDisplay(Math.round(getZoom() * 100)); });
  on('resetView', () => { if (!canvasReady) return; setZoom(1); setZoomDisplay(100); });

  // ── Grid / Snap / Rulers ───────────────────────────────────────────────────
  on('toggleGrid', ({ visible }) => { if (canvasReady) setGridVisible(visible); });
  on('toggleSnap', ({ enabled }) => { if (canvasReady) setSnapToGrid(enabled); });
  on('toggleRulers', () => { /* rulers optional enhancement */ });

  // ── Save ───────────────────────────────────────────────────────────────────
  on('save', () => _saveToServer());
  on('saveAs', () => _saveAsFile());

  // ── Board name ─────────────────────────────────────────────────────────────
  on('boardNameChange', ({ name }) => {
    if (board) board.boardName = name;
    _scheduleAutoSave();
  });

  // ── Flip / Align ──────────────────────────────────────────────────────────
  on('flipBoard', () => { if (canvasReady) flipBottom(); });
  on('alignSelected', () => { if (canvasReady) applyAlignment(); });

  // ── 3D View ────────────────────────────────────────────────────────────────
  on('view3d', () => {
    if (!board) return;
    syncPositions();
    open3DViewer(board);
  });

  // ── Export ────────────────────────────────────────────────────────────────
  on('export', async ({ format }) => {
    if (!board) return;
    syncPositions();
    switch (format) {
      case 'gerber':
        window.doGerberPreview?.();
        break;
      case 'netlist': {
        const md = exportMarkdown();
        _download(md, (board.boardName || 'pcb') + '-netlist.md', 'text/markdown');
        showToast('Netlist exported', 'success');
        break;
      }
      case 'json': {
        const json = JSON.stringify(serialize(board), null, 2);
        _download(json, (board.boardName || 'pcb') + '.json', 'application/json');
        showToast('JSON exported', 'success');
        break;
      }
      case 'bom':
        _exportBOM();
        break;
      default:
        showToast(`Export format "${format}" not yet implemented`, 'info');
    }
  });

  // ── Select component (from parts panel) ───────────────────────────────────
  on('selectComponent', ({ id }) => {
    if (!canvasReady || !id) return;
    selectItem(id);
  });

  // ── Place component (from modal) ──────────────────────────────────────────
  on('placeComponent', (data) => {
    if (!canvasReady) return;
    confirmComponent(data.label, data.type, data.pinCount, data.value || '');
  });

  // ── Create pour (from modal) ──────────────────────────────────────────────
  on('createPour', (data) => {
    if (!canvasReady) return;
    confirmPour(data.label, data.netType, data.color || '#888888', (data.opacity || 25) / 100);
    _afterMutation();
  });

  // ── Select all / Deselect ──────────────────────────────────────────────────
  on('selectAll', () => {
    if (!canvasReady) return;
    getCanvasInstance()?.discardActiveObject();
    // Fabric select all selectable objects
    const objs = getCanvasInstance()?.getObjects().filter(o => o.selectable);
    if (objs?.length) {
      const sel = new fabric.ActiveSelection(objs, { canvas: getCanvasInstance() });
      getCanvasInstance().setActiveObject(sel);
      getCanvasInstance().requestRenderAll();
    }
  });
  on('deselect', () => { getCanvasInstance()?.discardActiveObject(); getCanvasInstance()?.requestRenderAll(); });

  // ── Nudge ──────────────────────────────────────────────────────────────────
  on('nudge', ({ dx, dy, big }) => {
    if (!canvasReady) return;
    const step = big ? 10 : 1;
    const canvas = getCanvasInstance();
    canvas?.getActiveObjects().forEach(o => {
      o.set({ left: (o.left || 0) + dx * step, top: (o.top || 0) + dy * step });
      o.setCoords();
    });
    canvas?.requestRenderAll();
    _scheduleAutoSave();
  });

  // ── Board image upload buttons ────────────────────────────────────────────
  document.getElementById('img-top')?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    if (!canvasReady) { board = createBoard('New Board'); projectName = 'board_' + Date.now(); _initCanvasForBoard(board); }
    await _uploadOrReadImage(f, 'top');
    e.target.value = '';
  });
  document.getElementById('img-bot')?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    if (!canvasReady) { board = createBoard('New Board'); projectName = 'board_' + Date.now(); _initCanvasForBoard(board); }
    await _uploadOrReadImage(f, 'bottom');
    e.target.value = '';
  });

  // ── Clear recent ──────────────────────────────────────────────────────────
  on('clearRecentBoards', async () => {
    // Delete all server projects? No — just clear localStorage cache
    localStorage.removeItem('pcbmapper-recent');
    await _loadRecentBoards();
  });

  // ── Pin cancel banner ──────────────────────────────────────────────────────
  document.getElementById('pin-cancel-btn')?.addEventListener('click', () => {
    setTool('select');
    const banner = document.getElementById('pin-banner');
    if (banner) banner.style.display = 'none';
  });
  window.cancelPinPlace = () => {
    setTool('select');
    const banner = document.getElementById('pin-banner');
    if (banner) banner.style.display = 'none';
  };

  // ── Tutorial ──────────────────────────────────────────────────────────────
  window.closeTutorial = () => {
    const t = document.getElementById('tutorial-toast');
    if (t) t.style.display = 'none';
  };

  // ── 3D viewer buttons ──────────────────────────────────────────────────────
  window.close3D = close3DViewer;
  window.set3DView = (v) => import('./viewer3d.js').then(m => m.set3DView(v));

  // ── Window globals for HTML onclick handlers ──────────────────────────────
  window.goHome = () => {
    if (board) _saveToServer();
    _showLanding();
    _loadRecentBoards();
  };
  window.doFlipBottom = () => { if (canvasReady) flipBottom(); };
  window.doApplyAlign = () => { if (canvasReady) applyAlignment(); };
  window.doToggleGrid = () => {
    const btn = document.getElementById('btn-grid');
    const on = btn?.classList.toggle('active');
    if (canvasReady) setGridVisible(!!on);
  };
  window.doToggleSnap = () => {
    const btn = document.getElementById('btn-snap');
    const on = btn?.classList.toggle('active');
    if (canvasReady) setSnapToGrid(!!on);
  };
  window.doUndo = () => { if (canvasReady) undo(); _afterMutation(); };
  window.doRedo = () => { if (canvasReady) redo(); _afterMutation(); };
  window.doSave = () => _saveToServer();
  window.doExportMD = () => {
    if (!board) return;
    syncPositions();
    const md = exportMarkdown();
    _download(md, (board.boardName || 'pcb') + '-bom.md', 'text/markdown');
    showToast('BOM exported', 'success');
  };
  window.doExportGerber = async () => {
    if (!board) return;
    syncPositions();
    try {
      showToast('Generating Gerber files…', 'info');
      const zip = await exportGerber(board);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${board.boardName || 'pcb'}-gerber.zip`;
      a.click();
      showToast(`Gerber exported (${(blob.size / 1024).toFixed(0)} KB)`, 'success');
    } catch (e) {
      showToast('Gerber export failed: ' + e.message, 'error');
      console.error(e);
    }
  };
  // ── Trace Detection / AI Suggestions ────────────────────────────────────────
  let suggestionOverlays = [];

  window.doDetectTraces = () => {
    if (!board || !canvasReady) { showToast('Load a board first', 'warning'); return; }
    _runTraceDetection();
    // Switch to AI tab
    document.querySelectorAll('.ptab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.pcontent').forEach(x => x.classList.remove('active'));
    document.querySelector('.ptab[data-tab=suggest]')?.classList.add('active');
    document.getElementById('tab-suggest')?.classList.add('active');
  };

  document.getElementById('btn-analyze')?.addEventListener('click', () => _runTraceDetection());

  document.getElementById('detect-threshold')?.addEventListener('input', (e) => {
    const val = (parseInt(e.target.value) / 100).toFixed(2);
    document.getElementById('detect-thresh-val').textContent = val;
  });

  document.getElementById('chk-heatmap')?.addEventListener('change', (e) => {
    _toggleHeatmap(e.target.checked);
  });

  document.getElementById('btn-accept-all')?.addEventListener('click', () => {
    getSuggestions().filter(s => !s.rejected).forEach(s => _acceptSuggestion(s.id));
    _renderSuggestionList();
    showToast('All suggestions accepted as traces', 'success');
  });

  document.getElementById('btn-reject-all')?.addEventListener('click', () => {
    clearSuggestions();
    _clearSuggestionOverlays();
    _renderSuggestionList();
    showToast('Suggestions cleared', 'info');
  });

  function _runTraceDetection() {
    if (!board) return;
    syncPositions();

    // Find the board image on the canvas
    const canvasInst = getCanvasInstance();
    if (!canvasInst) return;

    const imgObj = canvasInst.getObjects().find(o => o.type === 'image');
    if (!imgObj) {
      showToast('No board image loaded — load a photo first (📷 Top or 📷 Bottom)', 'warning');
      return;
    }

    showToast('Analyzing board image for copper traces…', 'info', 3000);

    // Get the image element
    const imgEl = imgObj.getElement();
    if (!imgEl) { showToast('Could not access image data', 'error'); return; }

    // Gather all markers with canvas positions
    const markers = board.markers.map(m => ({
      id: m.id,
      label: m.label,
      x: m.x,
      y: m.y,
      t: m.t,
      markerType: m.markerType,
    }));

    // Include component pins
    board.markers.filter(m => m.t === 'pin').forEach(m => {
      if (!markers.find(x => x.id === m.id)) {
        markers.push({ id: m.id, label: m.label, x: m.x, y: m.y, t: 'pin' });
      }
    });

    const threshold = (parseInt(document.getElementById('detect-threshold')?.value || 25)) / 100;

    // Scale marker positions to image coordinates
    // The image might be scaled/offset on the canvas
    const imgLeft = imgObj.left || 0;
    const imgTop = imgObj.top || 0;
    const imgScaleX = (imgObj.scaleX || 1);
    const imgScaleY = (imgObj.scaleY || 1);
    const imgW = imgEl.naturalWidth || imgEl.width;
    const imgH = imgEl.naturalHeight || imgEl.height;

    const imageMarkers = markers.map(m => ({
      ...m,
      x: (m.x - imgLeft) / imgScaleX,
      y: (m.y - imgTop) / imgScaleY,
    })).filter(m => m.x >= 0 && m.x < imgW && m.y >= 0 && m.y < imgH);

    if (imageMarkers.length < 2) {
      showToast('Need at least 2 markers on the board image to detect traces', 'warning');
      return;
    }

    // Run analysis
    const results = analyzeBoard(imgEl, imageMarkers, { threshold, step: 3, maxSuggestions: 40 });

    // Convert suggestion paths back to canvas coordinates
    results.forEach(sug => {
      sug.canvasPath = sug.path.map(p => ({
        x: p.x * imgScaleX + imgLeft,
        y: p.y * imgScaleY + imgTop,
      }));
    });

    _clearSuggestionOverlays();
    _drawSuggestionOverlays(results);
    _renderSuggestionList();

    const count = results.length;
    showToast(`Found ${count} potential trace${count !== 1 ? 's' : ''}`, count ? 'success' : 'info');
  }

  function _drawSuggestionOverlays(suggestions) {
    const canvasInst = getCanvasInstance();
    if (!canvasInst) return;

    suggestions.forEach((sug, idx) => {
      if (sug.rejected || !sug.canvasPath || sug.canvasPath.length < 2) return;

      const points = sug.canvasPath.map(p => ({ x: p.x, y: p.y }));
      const line = new fabric.Polyline(points, {
        fill: null,
        stroke: sug.accepted ? '#44cc44' : '#cc44cc',
        strokeWidth: 2,
        strokeDashArray: sug.accepted ? null : [6, 4],
        selectable: false,
        evented: false,
        opacity: 0.7,
      });
      line._isSuggestion = true;
      line._sugId = sug.id;
      canvasInst.add(line);
      suggestionOverlays.push(line);
    });

    canvasInst.requestRenderAll();
  }

  function _clearSuggestionOverlays() {
    const canvasInst = getCanvasInstance();
    if (!canvasInst) return;
    suggestionOverlays.forEach(o => canvasInst.remove(o));
    suggestionOverlays = [];
    // Also remove heatmap overlay
    canvasInst.getObjects().filter(o => o._isHeatmap).forEach(o => canvasInst.remove(o));
    canvasInst.requestRenderAll();
  }

  function _acceptSuggestion(sugId) {
    const sug = acceptSuggestion(sugId);
    if (!sug || !sug.canvasPath || sug.canvasPath.length < 2) return;

    // Create a real trace from the suggestion
    const traceId = 'o' + (board.idCounter++);
    const trace = {
      id: traceId,
      t: 'trace',
      points: sug.canvasPath.map(p => ({ x: p.x, y: p.y })),
      width: 9,
      layer: 'top',
    };
    board.traces.push(trace);

    // Remove the suggestion overlay and redraw as accepted
    const canvasInst = getCanvasInstance();
    const overlay = suggestionOverlays.find(o => o._sugId === sugId);
    if (overlay && canvasInst) {
      overlay.set({ stroke: '#44cc44', strokeDashArray: null, opacity: 0.9 });
      canvasInst.requestRenderAll();
    }

    // Rebuild the trace on canvas
    rebuildCanvas(board);
    _afterMutation();
  }

  function _renderSuggestionList() {
    const el = document.getElementById('suggest-results');
    if (!el) return;
    const sugs = getSuggestions();

    if (!sugs.length) {
      el.innerHTML = '<p style="color:#555;font-size:11px">No suggestions. Load a board photo and place markers, then click Analyze.</p>';
      return;
    }

    el.innerHTML = sugs.map(s => {
      const conf = (s.confidence * 100).toFixed(0);
      const color = s.accepted ? '#44cc44' : s.rejected ? '#cc4444' : '#cc44cc';
      const icon = s.accepted ? '✓' : s.rejected ? '✕' : '?';
      return `<div style="padding:4px 0;border-bottom:1px solid #0f3460;display:flex;gap:6px;align-items:center;font-size:11px">
        <span style="color:${color};font-weight:bold;min-width:16px">${icon}</span>
        <span style="flex:1">${_esc(s.from.label)} → ${_esc(s.to.label)}</span>
        <span style="color:#888;font-size:10px">${conf}%</span>
        ${!s.accepted && !s.rejected ? `<button onclick="window._acceptSug('${s.id}')" style="padding:2px 6px;background:#1a3a1a;color:#44cc44;border:1px solid #0f3460;border-radius:3px;cursor:pointer;font-size:10px">✓</button>
        <button onclick="window._rejectSug('${s.id}')" style="padding:2px 6px;background:#3a1a1a;color:#cc4444;border:1px solid #0f3460;border-radius:3px;cursor:pointer;font-size:10px">✕</button>` : ''}
      </div>`;
    }).join('');

    document.getElementById('suggest-actions').style.display = sugs.length ? 'flex' : 'none';
  }

  window._acceptSug = (id) => { _acceptSuggestion(id); _renderSuggestionList(); };
  window._rejectSug = (id) => {
    rejectSuggestion(id);
    const canvasInst = getCanvasInstance();
    const overlay = suggestionOverlays.find(o => o._sugId === id);
    if (overlay && canvasInst) { canvasInst.remove(overlay); canvasInst.requestRenderAll(); }
    _renderSuggestionList();
  };

  function _toggleHeatmap(show) {
    const canvasInst = getCanvasInstance();
    if (!canvasInst) return;

    // Remove existing heatmap
    canvasInst.getObjects().filter(o => o._isHeatmap).forEach(o => canvasInst.remove(o));

    if (show) {
      const heatmap = generateHeatmap(canvasInst.width, canvasInst.height);
      if (heatmap) {
        const imgObj = new fabric.Image(heatmap, {
          left: 0, top: 0,
          selectable: false, evented: false,
          opacity: 0.5,
        });
        imgObj._isHeatmap = true;
        canvasInst.add(imgObj);
        canvasInst.requestRenderAll();
      }
    } else {
      canvasInst.requestRenderAll();
    }
  }

  // Gerber preview
  window.doGerberPreview = () => {
    if (!board) return;
    syncPositions();
    openGerberPreview(board);
  };
  document.getElementById('gp-close')?.addEventListener('click', () => closeGerberPreview());
  document.getElementById('gp-export')?.addEventListener('click', () => window.doExportGerber?.());

  window.doOpen3D = () => {
    if (!board) return;
    syncPositions();
    open3DViewer(board);
  };

  // ── Component/Pour modal window globals ────────────────────────────────────
  window.cancelNewBoard = () => {
    document.getElementById('new-board-modal').style.display = 'none';
  };
  window.confirmNewBoard = () => {
    const name = document.getElementById('nb-name')?.value?.trim() || 'Untitled';
    const w = parseFloat(document.getElementById('nb-width')?.value) || 0;
    const h = parseFloat(document.getElementById('nb-height')?.value) || 0;
    document.getElementById('new-board-modal').style.display = 'none';
    board = createBoard(name, w, h);
    projectName = _slugify(name) + '_' + Date.now();
    _hideElement('landing');
    _initCanvasForBoard(board);
    showToast(`Board "${name}" created`, 'success');
    _saveToServer();
  };
  window.cancelComp = () => {
    document.getElementById('comp-modal').style.display = 'none';
  };
  window.confirmComp = () => {
    const label = document.getElementById('cm-label')?.value || 'U?';
    const type = document.getElementById('cm-type')?.value || 'ic';
    const pins = parseInt(document.getElementById('cm-pins')?.value) || 2;
    const val = document.getElementById('cm-val')?.value || '';
    document.getElementById('comp-modal').style.display = 'none';
    if (canvasReady) confirmComponent(label, type, pins, val);
  };
  window.cancelPour = () => {
    document.getElementById('pour-modal').style.display = 'none';
  };
  window.confirmPour = () => {
    const label = document.getElementById('pm-label')?.value || 'Pour';
    const netType = document.getElementById('pm-type')?.value || 'ground';
    const color = document.getElementById('pm-color')?.value || '#888888';
    const opacity = parseInt(document.getElementById('pm-opacity')?.value) || 25;
    document.getElementById('pour-modal').style.display = 'none';
    if (canvasReady) confirmPour(label, netType, color, opacity / 100);
  };
  window.pourTypeChanged = () => {
    const netColors = { power: '#ff4444', ground: '#888888', signal: '#4488ff', other: '#44cc44' };
    const t = document.getElementById('pm-type')?.value;
    const colorEl = document.getElementById('pm-color');
    if (colorEl && netColors[t]) colorEl.value = netColors[t];
  };

  // ── Load file handler from topbar ──────────────────────────────────────────
  document.getElementById('load-f')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) { _hideElement('landing'); await _loadFromFile(f); }
    e.target.value = '';
  });

  // ── File loader from landing ──────────────────────────────────────────────
  document.getElementById('file-load-landing')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) { _hideElement('landing'); await _loadFromFile(f); }
    e.target.value = '';
  });

  // ── Layer selector ────────────────────────────────────────────────────────
  document.getElementById('layer-select')?.addEventListener('change', e => {
    if (canvasReady) setLayer(e.target.value);
  });

  // ── Landing buttons ───────────────────────────────────────────────────────
  document.getElementById('btn-new-board')?.addEventListener('click', () => {
    document.getElementById('new-board-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('nb-name')?.focus(), 100);
  });
  document.getElementById('btn-open-file')?.addEventListener('click', () => {
    document.getElementById('file-load-landing')?.click();
  });

  // ── Opacity display ───────────────────────────────────────────────────────
  document.getElementById('pm-opacity')?.addEventListener('input', () => {
    const el = document.getElementById('pm-opval');
    if (el) el.textContent = document.getElementById('pm-opacity').value + '%';
  });

  // ── Menu bar actions ──────────────────────────────────────────────────────
  document.querySelectorAll('.menu-action').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close all menus
      document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
      const action = item.dataset.action;
      switch (action) {
        case 'new': document.getElementById('new-board-modal').style.display = 'flex'; break;
        case 'open': document.getElementById('load-f')?.click() || document.getElementById('file-load-landing')?.click(); break;
        case 'save': _saveToServer(); break;
        case 'saveas': _saveAsFile(); break;
        case 'import-top': document.getElementById('img-top')?.click(); break;
        case 'import-bot': document.getElementById('img-bot')?.click(); break;
        case 'home': window.goHome(); break;
        case 'undo': if (canvasReady) { undo(); _afterMutation(); } break;
        case 'redo': if (canvasReady) { redo(); _afterMutation(); } break;
        case 'delete': {
          if (!canvasReady) break;
          const c = getCanvasInstance();
          c?.getActiveObjects().forEach(o => { if (o.pcb?.id) deleteById(o.pcb.id); });
          c?.discardActiveObject(); c?.requestRenderAll(); _afterMutation();
          break;
        }
        case 'selectall': {
          const c = getCanvasInstance();
          if (!c) break;
          c.discardActiveObject();
          const objs = c.getObjects().filter(o => o.selectable);
          if (objs.length) { const sel = new fabric.ActiveSelection(objs, { canvas: c }); c.setActiveObject(sel); c.requestRenderAll(); }
          break;
        }
        case 'zoomin': if (canvasReady) { setZoom(getZoom() * 1.25); setZoomDisplay(Math.round(getZoom() * 100)); } break;
        case 'zoomout': if (canvasReady) { setZoom(getZoom() * 0.8); setZoomDisplay(Math.round(getZoom() * 100)); } break;
        case 'zoomfit': if (canvasReady) { zoomToFit(); setZoomDisplay(Math.round(getZoom() * 100)); } break;
        case 'grid': window.doToggleGrid?.(); break;
        case 'snap': window.doToggleSnap?.(); break;
        case '3d': window.doOpen3D?.(); break;
        case 'gerber': window.doGerberPreview?.(); break;
        case 'bom': _exportBOM(); break;
        case 'json': {
          if (!board) break;
          syncPositions();
          _download(JSON.stringify(serialize(board), null, 2), (board.boardName || 'pcb') + '.json', 'application/json');
          showToast('JSON exported', 'success');
          break;
        }
        case 'md': window.doExportMD?.(); break;
        case 'tutorial': { const t = document.getElementById('tutorial-toast'); if (t) t.style.display = 'block'; break; }
        case 'shortcuts': document.getElementById('shortcuts-modal').style.display = 'flex'; break;
        case 'about': document.getElementById('about-modal').style.display = 'flex'; break;
      }
    });
  });

  // ── Context Menu ──────────────────────────────────────────────────────────
  const ctxMenu = document.getElementById('ctx-menu');
  let ctxTarget = null;

  // Right-click via Fabric's mouse:down (button=3) since Fabric has stopContextMenu
  const _showCtxMenu = (fabricEvent) => {
    const e = fabricEvent.e;
    e.preventDefault?.();
    if (!canvasReady) return;

    const target = fabricEvent.target;
    ctxTarget = target?.pcb || null;

    let items = '';
    if (ctxTarget) {
      items += `<div class="ctx-item" data-ctx="props">📋 Properties</div>`;
      if (['marker', 'smd', 'pin'].includes(ctxTarget.t)) {
        items += `<div class="ctx-item" data-ctx="net-from">⟋ Start Net From Here</div>`;
      }
      items += `<div class="ctx-item" data-ctx="highlight-nets">🔍 Highlight Connected Nets</div>`;
      items += `<div class="ctx-sep"></div>`;
      items += `<div class="ctx-item" data-ctx="to-front">↑ Bring to Front</div>`;
      items += `<div class="ctx-item" data-ctx="to-back">↓ Send to Back</div>`;
      items += `<div class="ctx-sep"></div>`;
      items += `<div class="ctx-item" data-ctx="delete" style="color:#e94560">🗑 Delete</div>`;
    } else {
      items += `<div class="ctx-item" data-ctx="zoom-fit">⊞ Zoom to Fit</div>`;
      items += `<div class="ctx-item" data-ctx="grid">⊞ Toggle Grid</div>`;
      items += `<div class="ctx-item" data-ctx="snap">⊞ Toggle Snap</div>`;
      items += `<div class="ctx-sep"></div>`;
      items += `<div class="ctx-item" data-ctx="paste">📋 Paste</div>`;
    }

    if (ctxMenu) {
      ctxMenu.innerHTML = items;
      ctxMenu.style.display = 'block';
      ctxMenu.style.left = e.clientX + 'px';
      ctxMenu.style.top = e.clientY + 'px';

      // Wire actions
      ctxMenu.querySelectorAll('.ctx-item').forEach(item => {
        item.addEventListener('click', () => {
          ctxMenu.style.display = 'none';
          const act = item.dataset.ctx;
          switch (act) {
            case 'props':
              if (ctxTarget) {
                const obj = getCanvasInstance()?.getObjects().find(o => o.pcb?.id === ctxTarget.id);
                if (obj) { getCanvasInstance().setActiveObject(obj); getCanvasInstance().requestRenderAll(); _renderProps(obj); }
              }
              break;
            case 'net-from':
              if (ctxTarget) startNetFrom(ctxTarget);
              break;
            case 'highlight-nets':
              if (ctxTarget && board) {
                // Find nets connected to this element
                const connNets = board.nets.filter(n => n.fromId === ctxTarget.id || n.toId === ctxTarget.id);
                if (connNets.length) highlightNet(connNets[0].id, board);
              }
              break;
            case 'to-front': {
              const obj = getCanvasInstance()?.getObjects().find(o => o.pcb?.id === ctxTarget?.id);
              if (obj) { obj.bringToFront(); getCanvasInstance().requestRenderAll(); }
              break;
            }
            case 'to-back': {
              const obj = getCanvasInstance()?.getObjects().find(o => o.pcb?.id === ctxTarget?.id);
              if (obj) { obj.sendToBack(); getCanvasInstance().requestRenderAll(); }
              break;
            }
            case 'delete':
              if (ctxTarget) { deleteById(ctxTarget.id); _afterMutation(); }
              break;
            case 'zoom-fit': zoomToFit(); setZoomDisplay(Math.round(getZoom() * 100)); break;
            case 'grid': window.doToggleGrid?.(); break;
            case 'snap': window.doToggleSnap?.(); break;
          }
        });
      });
    }
  };

  // Wire right-click context menu to canvas callbacks
  // We'll register it after canvas is created in _initCanvasForBoard

  // Close context menu on click elsewhere
  document.addEventListener('click', () => { if (ctxMenu) ctxMenu.style.display = 'none'; });
  document.addEventListener('contextmenu', (e) => {
    // Prevent default browser context menu on the canvas area
    if (e.target.closest('#canvas-wrap')) e.preventDefault();
  });

  // ── Marker type buttons ────────────────────────────────────────────────────
  document.querySelectorAll('.marker-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mt = btn.dataset.mtype;
      setMarkerType(mt);
      document.querySelectorAll('.marker-type-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.style.borderColor = b === btn ? '#89b4fa' : '#0f3460';
        b.style.background = b === btn ? '#1a3a6e' : '#1a1a2e';
      });
    });
  });

  // ── DRC button ─────────────────────────────────────────────────────────────
  document.getElementById('btn-run-drc')?.addEventListener('click', () => _runDRC());

  // ── Board name in menu bar ────────────────────────────────────────────────
  const boardNameEl = document.getElementById('menu-board-name');
  if (boardNameEl) {
    boardNameEl.addEventListener('blur', () => {
      if (board) { board.boardName = boardNameEl.textContent.trim(); _scheduleAutoSave(); }
    });
    boardNameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); boardNameEl.blur(); }
    });
  }

  // ── Keyboard shortcuts (global) ───────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl) {
      switch (key) {
        case 'n': e.preventDefault(); document.getElementById('new-board-modal').style.display = 'flex'; break;
        case 'o': e.preventDefault(); document.getElementById('load-f')?.click(); break;
        case 's': e.preventDefault(); _saveToServer(); showToast('Saved', 'success'); break;
        case 'z': e.preventDefault(); if (e.shiftKey) { redo(); } else { undo(); } _afterMutation(); break;
        case 'y': e.preventDefault(); redo(); _afterMutation(); break;
        case 'a': e.preventDefault(); document.querySelector('.menu-action[data-action=selectall]')?.click(); break;
        case '3': e.preventDefault(); window.doOpen3D?.(); break;
        case '0': e.preventDefault(); if (canvasReady) { zoomToFit(); setZoomDisplay(Math.round(getZoom() * 100)); } break;
        case '=': case '+': e.preventDefault(); if (canvasReady) { setZoom(getZoom() * 1.25); setZoomDisplay(Math.round(getZoom() * 100)); } break;
        case '-': e.preventDefault(); if (canvasReady) { setZoom(getZoom() * 0.8); setZoomDisplay(Math.round(getZoom() * 100)); } break;
        case 'i': e.preventDefault(); document.getElementById('img-top')?.click(); break;
        case 'f': e.preventDefault(); if (canvasReady) flipBottom(); break;
      }
      return;
    }

    // Tool shortcuts
    const toolMap = { v: 'select', h: 'pan', m: 'marker', c: 'component', d: 'smd', n: 'net', t: 'trace', p: 'pour', x: 'punchout', o: 'outline', a: 'align', u: 'measure' };
    if (toolMap[key] && canvasReady) {
      const tool = toolMap[key];
      if (tool === 'component') {
        document.querySelector('[data-tool=component]')?.click();
      } else if (tool === 'pour') {
        document.querySelector('[data-tool=pour]')?.click();
      } else {
        setTool(tool);
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
        document.getElementById('st-tool').textContent = tool[0].toUpperCase() + tool.slice(1);
        const mtBar = document.getElementById('marker-type-bar');
        if (mtBar) mtBar.style.display = tool === 'marker' ? 'flex' : 'none';
      }
      return;
    }

    if (key === 'g') { window.doToggleGrid?.(); return; }
    if (key === 'delete' || key === 'backspace') { document.querySelector('.menu-action[data-action=delete]')?.click(); return; }
    if (key === 'escape') {
      const modals = document.querySelectorAll('.modal-overlay');
      modals.forEach(m => m.style.display = 'none');
      const tutorial = document.getElementById('tutorial-toast');
      if (tutorial) tutorial.style.display = 'none';
    }
  });
}

// ─── Parts panel refresh ──────────────────────────────────────────────────────
function _refreshPartsPanel() {
  if (!board) return;

  // Components list
  const compList = document.getElementById('cl-comp');
  if (compList) {
    if (board.components.length === 0) {
      compList.innerHTML = '<li style="color:#555;cursor:default">No components</li>';
    } else {
      compList.innerHTML = board.components.map(c =>
        `<li data-id="${c.id}" title="${_esc(c.value || '')}">${_esc(c.label)} <span style="color:#666;font-size:10px">${c.compType}</span><span class="x">✕</span></li>`
      ).join('');
      compList.querySelectorAll('li[data-id]').forEach(li => {
        li.addEventListener('click', () => { if (canvasReady) selectItem(li.dataset.id); });
        li.querySelector('.x')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (canvasReady) { deleteById(li.dataset.id); _afterMutation(); }
        });
      });
    }
  }

  // Markers list
  const markList = document.getElementById('cl-mark');
  if (markList) {
    const markers = board.markers.filter(m => m.t !== 'pin');
    if (markers.length === 0) {
      markList.innerHTML = '<li style="color:#555;cursor:default">No markers</li>';
    } else {
      markList.innerHTML = markers.map(m => {
        const typeColor = m.t === 'smd' ? '#00ccaa' : m.markerType === 'via' ? '#ffaa00' : '#ff6600';
        return `<li data-id="${m.id}"><span style="color:${typeColor}">●</span> ${_esc(m.label)} <span style="color:#666;font-size:10px">${m.t === 'smd' ? 'SMD' : (m.markerType || '')}</span><span class="x">✕</span></li>`;
      }).join('');
      markList.querySelectorAll('li[data-id]').forEach(li => {
        li.addEventListener('click', () => { if (canvasReady) selectItem(li.dataset.id); });
        li.querySelector('.x')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (canvasReady) { deleteById(li.dataset.id); _afterMutation(); }
        });
      });
    }
  }

  // Nets list
  const netList = document.getElementById('cl-net');
  if (netList) {
    if (!board.nets.length) {
      netList.innerHTML = '<li style="color:#555;cursor:default">No connections</li>';
    } else {
      netList.innerHTML = board.nets.map(n => {
        const f = board.markers.find(m => m.id === n.fromId);
        const t = board.markers.find(m => m.id === n.toId);
        const typeColor = { power: '#ff4444', ground: '#888', signal: '#4488ff', other: '#44cc44' }[n.netType] || '#888';
        return `<li data-id="${n.id}"><span style="color:${typeColor}">━</span> ${_esc(f?.label || '?')} → ${_esc(t?.label || '?')} <span style="color:#666;font-size:10px">${n.netType}</span><span class="x">✕</span></li>`;
      }).join('');
      netList.querySelectorAll('li[data-id]').forEach(li => {
        li.addEventListener('click', () => {
          if (canvasReady && board) {
            // Toggle highlight
            netList.querySelectorAll('li').forEach(x => x.classList.remove('highlighted'));
            li.classList.add('highlighted');
            highlightNet(li.dataset.id, board);
          }
        });
        li.querySelector('.x')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (canvasReady) { clearNetHighlight(); deleteById(li.dataset.id); _afterMutation(); }
        });
      });
    }
  }

  // Traces list
  const traceList = document.getElementById('cl-trace');
  if (traceList) {
    if (!board.traces?.length) {
      traceList.innerHTML = '<li style="color:#555;cursor:default">No traces</li>';
    } else {
      traceList.innerHTML = board.traces.map((t, i) =>
        `<li data-id="${t.id}"><span style="color:#44ff88">╱</span> Trace ${i + 1} <span style="color:#666;font-size:10px">${t.points?.length || 0}pts ${t.layer}</span><span class="x">✕</span></li>`
      ).join('');
      traceList.querySelectorAll('li[data-id]').forEach(li => {
        li.addEventListener('click', () => { if (canvasReady) selectItem(li.dataset.id); });
        li.querySelector('.x')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (canvasReady) { deleteById(li.dataset.id); _afterMutation(); }
        });
      });
    }
  }

  // Pours list
  const pourList = document.getElementById('cl-pour');
  if (pourList) {
    if (!board.pours?.length) {
      pourList.innerHTML = '<li style="color:#555;cursor:default">No pours</li>';
    } else {
      pourList.innerHTML = board.pours.map(p =>
        `<li data-id="${p.id}"><span style="color:${p.color || '#888'}">⬡</span> ${_esc(p.label)} <span style="color:#666;font-size:10px">${p.netType} ${p.layer}</span><span class="x">✕</span></li>`
      ).join('');
      pourList.querySelectorAll('li[data-id]').forEach(li => {
        li.addEventListener('click', () => { if (canvasReady) selectItem(li.dataset.id); });
        li.querySelector('.x')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (canvasReady) { deleteById(li.dataset.id); _afterMutation(); }
        });
      });
    }
  }

  // Try toolbar's version too (in case it works)
  try { updatePartsPanel(board.components); } catch { /* noop */ }
}

// ─── Props panel ──────────────────────────────────────────────────────────────
function _renderProps(obj) {
  const propsEl = document.getElementById('props');
  if (!propsEl) return;
  const d = obj.pcb;
  let h = `<label>ID</label><input value="${d.id}" readonly>`;
  if (d.t === 'marker' && d.markerType !== undefined) {
    h += `<label>Marker Type</label><select onchange="window._setMarkerType('${d.id}',this.value)">
      <option value="via" ${d.markerType==='via'?'selected':''}>Via</option>
      <option value="hole" ${d.markerType==='hole'?'selected':''}>Through-Hole</option>
      <option value="testpoint" ${d.markerType==='testpoint'?'selected':''}>Test Point</option>
    </select>`;
  } else {
    h += `<label>Type</label><input value="${d.t}" readonly>`;
  }
  if (d.label !== undefined) h += `<label>Label</label><input id="prop-label" value="${_esc(d.label)}" onchange="window._setProp('${d.id}','label',this.value)">`;
  if (d.value !== undefined) h += `<label>Value/Notes</label><input value="${_esc(d.value || '')}" onchange="window._setProp('${d.id}','value',this.value)">`;
  if (d.holeSize !== undefined) {
    h += `<div class="prop-row"><label>Hole Size</label><input type="range" min="1" max="30" value="${d.holeSize}" oninput="window._setHoleSize('${d.id}',this.value);this.nextElementSibling.textContent=this.value+'px'"><span class="prop-val">${d.holeSize}px</span></div>`;
  }
  if (d.t === 'smd') {
    const pw = d.padWidth || 14, ph = d.padHeight || 8;
    h += `<div class="prop-row"><label>Pad W</label><input type="range" min="4" max="60" value="${pw}" oninput="window._setPadSize('${d.id}','w',this.value);this.nextElementSibling.textContent=this.value+'px'"><span class="prop-val">${pw}px</span></div>`;
    h += `<div class="prop-row"><label>Pad H</label><input type="range" min="4" max="60" value="${ph}" oninput="window._setPadSize('${d.id}','h',this.value);this.nextElementSibling.textContent=this.value+'px'"><span class="prop-val">${ph}px</span></div>`;
  }
  if (d.t === 'trace') {
    const w = d.width || 3;
    h += `<div class="prop-row"><label>Width</label><input type="range" min="1" max="30" value="${w}" oninput="window._setTraceWidth('${d.id}',this.value);this.nextElementSibling.textContent=this.value+'px'"><span class="prop-val">${w}px</span></div>`;
  }
  if (d.netType) {
    h += `<label>Net Type</label><select onchange="window._setProp('${d.id}','netType',this.value)">${['power','ground','signal','other'].map(t => `<option value="${t}" ${d.netType===t?'selected':''}>${t}</option>`).join('')}</select>`;
  }
  if (d.layer) {
    h += `<label>Layer</label><select onchange="window._setProp('${d.id}','layer',this.value)"><option value="top" ${d.layer==='top'?'selected':''}>Top</option><option value="bottom" ${d.layer==='bottom'?'selected':''}>Bottom</option><option value="both" ${d.layer==='both'?'selected':''}>Both</option></select>`;
  }
  // Position info
  h += `<label style="margin-top:8px;color:#555">Position</label>`;
  h += `<div style="display:flex;gap:4px;font-size:11px;color:#888"><span>X: ${Math.round(obj.left || 0)}</span><span>Y: ${Math.round(obj.top || 0)}</span></div>`;

  if (['marker','smd','pin'].includes(d.t)) {
    h += `<button style="margin-top:8px;width:100%;background:#16213e;color:#4488ff;border:1px solid #0f3460;border-radius:4px;padding:5px;cursor:pointer;font-size:11px" onclick="window._startNet('${d.id}')">⟋ Start Net From Here</button>`;
  }
  propsEl.innerHTML = h;
  switchPanelTab('props');
}

// Global property setters (called from inline onchange)
window._setProp = (id, prop, val) => {
  if (!board || !canvasReady) return;
  const canvas = getCanvasInstance();
  const obj = canvas.getObjects().find(o => o.pcb?.id === id);
  if (obj) {
    obj.pcb[prop] = val;
    if (prop === 'label') { const lbl = canvas.getObjects().find(o => o.pcb?.lf === id); if (lbl) lbl.set('text', val); }
    canvas.requestRenderAll();
  }
  const item = board.markers.find(m => m.id === id) || board.components.find(c => c.id === id) || board.nets.find(n => n.id === id) || board.traces.find(t => t.id === id);
  if (item) item[prop] = val;
  _scheduleAutoSave();
};

window._setMarkerType = (id, newType) => {
  if (!board || !canvasReady) return;
  const canvas = getCanvasInstance();
  const obj = canvas.getObjects().find(o => o.pcb?.id === id);
  if (!obj) return;
  const COLORS = { via: '#ffaa00', hole: '#ff6600', testpoint: '#00ccaa' };
  const SIZES = { via: 6, hole: 11, testpoint: 3 };
  obj.pcb.markerType = newType;
  obj.pcb.holeSize = SIZES[newType] || 6;
  obj.set({ fill: COLORS[newType] || '#ffaa00', radius: obj.pcb.holeSize });
  obj.setCoords();
  canvas.requestRenderAll();
  const item = board.markers.find(m => m.id === id);
  if (item) { item.markerType = newType; item.holeSize = obj.pcb.holeSize; }
  _scheduleAutoSave();
  // Re-render props to update the hole size slider
  _renderProps(obj);
};

window._setHoleSize = (id, val) => {
  const v = parseInt(val);
  const canvas = getCanvasInstance();
  const obj = canvas?.getObjects().find(o => o.pcb?.id === id);
  if (obj) { obj.set('radius', v); obj.pcb.holeSize = v; canvas.requestRenderAll(); }
  const m = board?.markers.find(m => m.id === id); if (m) m.holeSize = v;
  _scheduleAutoSave();
};

window._setPadSize = (id, dim, val) => {
  const v = parseInt(val);
  const canvas = getCanvasInstance();
  const obj = canvas?.getObjects().find(o => o.pcb?.id === id);
  if (obj) { if (dim === 'w') { obj.set('width', v); obj.pcb.padWidth = v; } else { obj.set('height', v); obj.pcb.padHeight = v; } canvas.requestRenderAll(); }
  const m = board?.markers.find(m => m.id === id); if (m) { if (dim === 'w') m.padWidth = v; else m.padHeight = v; }
  _scheduleAutoSave();
};

window._setTraceWidth = (id, val) => {
  const v = parseInt(val);
  const canvas = getCanvasInstance();
  const obj = canvas?.getObjects().find(o => o.pcb?.id === id);
  if (obj) { obj.set('strokeWidth', v); obj.pcb.width = v; canvas.requestRenderAll(); }
  const t = board?.traces.find(t => t.id === id); if (t) t.width = v;
  _scheduleAutoSave();
};

window._startNet = (id) => {
  const canvas = getCanvasInstance();
  const obj = canvas?.getObjects().find(o => o.pcb?.id === id);
  if (obj) startNetFrom(obj.pcb);
};

// ─── After mutation ────────────────────────────────────────────────────────────
function _afterMutation() {
  _refreshPartsPanel();
  _scheduleAutoSave();
}

// ─── Save / Load ───────────────────────────────────────────────────────────────
function _scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(_saveToServer, 2500);
}

async function _saveToServer(skipSync = false) {
  if (!board || !projectName) return;
  if (!skipSync && canvasReady) {
    try { syncPositions(); } catch { /* canvas may not be ready */ }
  }
  setAutoSaveState('saving');
  try {
    await _apiPost(`${API}/${projectName}`, serialize(board));
    setAutoSaveState('saved');
  } catch {
    setAutoSaveState('error');
  }
}

function _saveAsFile() {
  if (!board) return;
  syncPositions();
  const json = JSON.stringify(serialize(board), null, 2);
  _download(json, (board.boardName || 'pcb') + '.json', 'application/json');
  showToast('Saved as JSON', 'success');
}

async function _loadFromFile(file) {
  let raw;
  if (file.name.endsWith('.json')) {
    raw = JSON.parse(await file.text());
    board = deserialize(raw);
    projectName = _slugify(file.name.replace(/\.[^.]+$/, '')) + '_' + Date.now();
    _initCanvasForBoard(board);
    _saveToServer(true);
    showToast('Loaded JSON', 'success');
  } else if (typeof JSZip !== 'undefined') {
    const zip = await JSZip.loadAsync(file);
    const jf = zip.file('project.json');
    if (!jf) throw new Error('No project.json found');
    raw = JSON.parse(await jf.async('text'));
    board = deserialize(raw);
    projectName = _slugify(board.boardName || 'board') + '_' + Date.now();
    _initCanvasForBoard(board);
    for (const side of ['top', 'bottom']) {
      const match = Object.keys(zip.files).find(n => n.startsWith(side + '.'));
      if (match) {
        const imgData = await zip.file(match).async('base64');
        const ext = match.split('.').pop();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        await loadBoardImage(side, `data:${mime};base64,${imgData}`);
      }
    }
    _saveToServer(true);
    showToast('Loaded .pcbm', 'success');
  } else {
    throw new Error('JSZip not available for .pcbm files');
  }
}

async function _uploadOrReadImage(file, side) {
  if (projectName) {
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(`${API}/${projectName}/images/${side}`, { method: 'POST', body: form });
      if (res.ok) {
        const { url } = await res.json();
        await loadBoardImage(side, url + '?t=' + Date.now());
        showToast(`${side} image uploaded`, 'success');
        return;
      }
    } catch { /* fall through */ }
  }
  const reader = new FileReader();
  reader.onload = async ev => { await loadBoardImage(side, ev.target.result); showToast(`${side} image loaded`, 'success'); };
  reader.readAsDataURL(file);
}

// ─── BOM export ────────────────────────────────────────────────────────────────
function _exportBOM() {
  if (!board) return;
  const rows = ['Reference,Type,Value,Layer,Pins'];
  board.components.forEach(c => {
    const pins = board.markers.filter(m => m.t === 'pin' && m.parentId === c.id).length;
    rows.push(`${c.label},${c.compType},"${c.value || ''}",${c.layer},${pins}`);
  });
  _download(rows.join('\n'), (board.boardName || 'pcb') + '-bom.csv', 'text/csv');
  showToast('BOM exported', 'success');
}

// ─── DRC ──────────────────────────────────────────────────────────────────────
function _runDRC() {
  if (!board) { showToast('No board loaded', 'warning'); return; }
  syncPositions();
  const issues = [];

  // Board dimensions
  if (!board.boardWidth || !board.boardHeight) {
    issues.push({ severity: 'warning', msg: 'Board dimensions not set' });
  }

  // Board outline
  if (!board.outline || board.outline.length < 3) {
    issues.push({ severity: 'warning', msg: 'No board outline defined' });
  }

  // Unconnected pins
  const connectedIds = new Set();
  board.nets.forEach(n => { connectedIds.add(n.fromId); connectedIds.add(n.toId); });
  const pins = board.markers.filter(m => m.t === 'pin');
  const unconnected = pins.filter(p => !connectedIds.has(p.id));
  if (unconnected.length) {
    issues.push({ severity: 'error', msg: `${unconnected.length} unconnected pin(s): ${unconnected.slice(0, 5).map(p => p.label).join(', ')}${unconnected.length > 5 ? '…' : ''}` });
  }

  // Components missing pins
  board.components.forEach(c => {
    const cPins = board.markers.filter(m => m.t === 'pin' && m.parentId === c.id);
    if (cPins.length === 0) {
      issues.push({ severity: 'warning', msg: `${c.label} has no pins placed (expected ${c.pinCount})` });
    } else if (cPins.length < c.pinCount) {
      issues.push({ severity: 'info', msg: `${c.label}: ${cPins.length}/${c.pinCount} pins placed` });
    }
  });

  // Thin traces
  const badTraces = (board.traces || []).filter(t => !t.width || t.width < 1);
  if (badTraces.length) {
    issues.push({ severity: 'warning', msg: `${badTraces.length} trace(s) below 1px width` });
  }

  // Overlapping markers
  const posMap = {};
  board.markers.forEach(m => {
    const key = `${Math.round(m.x)},${Math.round(m.y)}`;
    if (posMap[key]) { issues.push({ severity: 'warning', msg: `Overlapping: ${posMap[key].label} & ${m.label}` }); }
    posMap[key] = m;
  });

  if (!issues.length) {
    issues.push({ severity: 'pass', msg: 'All checks passed ✓' });
  }

  // Render results
  const el = document.getElementById('drc-results');
  if (el) {
    const icons = { error: '🔴', warning: '🟡', info: '🔵', pass: '🟢' };
    el.innerHTML = issues.map(i =>
      `<div style="padding:4px 0;border-bottom:1px solid #0f3460;display:flex;gap:6px;align-items:center"><span>${icons[i.severity] || '⚪'}</span><span>${_esc(i.msg)}</span></div>`
    ).join('');
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  showToast(`DRC: ${errors} error(s), ${warnings} warning(s)`, errors ? 'error' : warnings ? 'warning' : 'success');

  // Switch to DRC tab
  document.querySelectorAll('.ptab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.pcontent').forEach(x => x.classList.remove('active'));
  document.querySelector('.ptab[data-tab=drc]')?.classList.add('active');
  document.getElementById('tab-drc')?.classList.add('active');
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function _showLanding() {
  const landing = document.getElementById('landing');
  if (landing) landing.style.display = 'flex';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _hideElement(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function _slugify(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _download(text, filename, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

async function _apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function _apiPost(url, data) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
