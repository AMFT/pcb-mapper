/**
 * PCB Mapper v2 — toolbar.js
 * Handles: tool switching, menu dropdowns, panel tabs, keyboard shortcuts,
 * toast notifications, modal management, resizable panel, resistor calculator.
 *
 * All exported functions are called from app.js.
 */

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

let _currentTool = 'select';
let _gridVisible = true;
let _snapEnabled = true;
let _rulersVisible = true;
let _activeModal = null;
let _panelResizing = false;
let _calcBandCount = 4;

// Action bus — app.js subscribes to these
const _listeners = {};

function emit(event, data) {
  (_listeners[event] || []).forEach(fn => fn(data));
}

export function on(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
}

// ═══════════════════════════════════════════════════════════════════
// Tool Management
// ═══════════════════════════════════════════════════════════════════

export function setActiveTool(name) {
  const prev = _currentTool;
  _currentTool = name;

  // Update toolbar button states
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === name);
  });

  // Update canvas cursor
  const canvas = document.getElementById('canvas-container');
  if (canvas) canvas.dataset.tool = name;

  // Update status bar
  const statusTool = document.getElementById('status-tool');
  if (statusTool) {
    statusTool.textContent = _toolDisplayName(name);
  }

  emit('toolChange', { tool: name, prev });
}

export function getCurrentTool() {
  return _currentTool;
}

function _toolDisplayName(name) {
  const map = {
    select: 'Select', pan: 'Pan', marker: 'Marker', component: 'Component',
    pad: 'Pad', net: 'Net', trace: 'Trace', bus: 'Bus',
    pour: 'Pour', punchout: 'Punchout', outline: 'Outline',
    align: 'Align', measure: 'Measure', dimension: 'Dimension',
  };
  return map[name] || name;
}

function _initToolbar() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      // Component/pour tools open a modal first
      if (tool === 'component') {
        setActiveTool(tool);
        openModal('modal-component');
      } else if (tool === 'pour') {
        setActiveTool(tool);
        openModal('modal-pour');
      } else {
        setActiveTool(tool);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Menu Bar Dropdowns
// ═══════════════════════════════════════════════════════════════════

function _initMenuBar() {
  const menuItems = document.querySelectorAll('.menu-item');

  menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
      const isOpen = item.classList.contains('open');
      // Close all first
      menuItems.forEach(m => m.classList.remove('open'));
      if (!isOpen) {
        item.classList.add('open');
      }
      e.stopPropagation();
    });

    // Hover to switch when another menu is open
    item.addEventListener('mouseenter', () => {
      const anyOpen = document.querySelector('.menu-item.open');
      if (anyOpen && anyOpen !== item) {
        anyOpen.classList.remove('open');
        item.classList.add('open');
      }
    });
  });

  // Close on outside click
  document.addEventListener('click', () => {
    menuItems.forEach(m => m.classList.remove('open'));
  });

  // Wire up menu actions
  document.querySelectorAll('.menu-action[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _handleMenuAction(btn.dataset.action);
      // Close menus
      document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
    });
  });
}

function _handleMenuAction(action) {
  switch (action) {
    case 'new-board':      openModal('modal-new-board'); break;
    case 'open-project':   _triggerFileOpen('.pcbmap,.json'); break;
    case 'save':           emit('save', {}); showToast('Project saved', 'success'); break;
    case 'save-as':        emit('saveAs', {}); break;
    case 'import-top':     _triggerFileOpen('image/*', 'top'); break;
    case 'import-bottom':  _triggerFileOpen('image/*', 'bottom'); break;
    case 'import-image':   _triggerFileOpen('image/*', 'top'); break;
    case 'export-gerber':  emit('export', { format: 'gerber' }); showToast('Exporting Gerber…', 'info'); break;
    case 'export-bom':     emit('export', { format: 'bom' }); showToast('Exporting BOM…', 'info'); break;
    case 'export-netlist': emit('export', { format: 'netlist' }); break;
    case 'export-png':     emit('export', { format: 'png' }); break;
    case 'export-pdf':     emit('export', { format: 'pdf' }); break;
    case 'export-json':    emit('export', { format: 'json' }); break;
    case 'undo':           emit('undo', {}); break;
    case 'redo':           emit('redo', {}); break;
    case 'delete':         emit('deleteSelected', {}); break;
    case 'select-all':     emit('selectAll', {}); break;
    case 'deselect':       emit('deselect', {}); break;
    case 'zoom-in':        emit('zoom', { delta: 0.25 }); break;
    case 'zoom-out':       emit('zoom', { delta: -0.25 }); break;
    case 'zoom-fit':       emit('zoomFit', {}); break;
    case 'toggle-grid':    _toggleGrid(); break;
    case 'toggle-rulers':  _toggleRulers(); break;
    case 'view-3d':        emit('view3d', {}); showToast('3D View coming soon', 'info'); break;
    case 'reset-view':     emit('resetView', {}); break;
    case 'show-shortcuts': openModal('modal-shortcuts'); break;
    case 'tutorial':       showToast('Tutorial coming soon', 'info'); break;
    case 'about':          openModal('modal-about'); break;

    // Tool activations from menu
    default:
      if (action.startsWith('tool-')) {
        const tool = action.slice(5);
        setActiveTool(tool);
      }
      break;
  }
}

function _triggerFileOpen(accept, meta) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) emit('fileOpen', { file, meta });
  };
  input.click();
}

// ═══════════════════════════════════════════════════════════════════
// Toggle states
// ═══════════════════════════════════════════════════════════════════

function _toggleGrid() {
  _gridVisible = !_gridVisible;
  const btn = document.getElementById('btn-grid-toggle');
  const menuItem = document.getElementById('menu-toggle-grid');
  if (btn) btn.classList.toggle('active', _gridVisible);
  if (menuItem) menuItem.classList.toggle('active', _gridVisible);
  emit('toggleGrid', { visible: _gridVisible });
}

function _toggleSnap() {
  _snapEnabled = !_snapEnabled;
  const btn = document.getElementById('btn-snap-toggle');
  if (btn) btn.classList.toggle('active', _snapEnabled);
  emit('toggleSnap', { enabled: _snapEnabled });
  showToast(`Snap ${_snapEnabled ? 'enabled' : 'disabled'}`, 'info');
}

function _toggleRulers() {
  _rulersVisible = !_rulersVisible;
  const menuItem = document.getElementById('menu-toggle-rulers');
  if (menuItem) menuItem.classList.toggle('active', _rulersVisible);
  const rulerH = document.getElementById('ruler-h');
  const rulerV = document.getElementById('ruler-v');
  const corner = document.querySelector('.ruler-corner');
  [rulerH, rulerV, corner].forEach(el => el && (el.hidden = !_rulersVisible));
  emit('toggleRulers', { visible: _rulersVisible });
}

// ═══════════════════════════════════════════════════════════════════
// Panel Tabs
// ═══════════════════════════════════════════════════════════════════

function _initPanelTabs() {
  const tabs = document.querySelectorAll('.panel-tab[data-tab]');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchPanelTab(tab.dataset.tab));
  });
}

export function switchPanelTab(tabName) {
  document.querySelectorAll('.panel-tab').forEach(t => {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive);
  });

  document.querySelectorAll('.tab-pane').forEach(pane => {
    const isActive = pane.id === `tab-${tabName}`;
    pane.classList.toggle('active', isActive);
    pane.hidden = !isActive;
  });

  emit('panelTabChange', { tab: tabName });
}

// ═══════════════════════════════════════════════════════════════════
// Top Action Bar
// ═══════════════════════════════════════════════════════════════════

function _initTopActionBar() {
  document.getElementById('btn-grid-toggle')?.addEventListener('click', _toggleGrid);
  document.getElementById('btn-snap-toggle')?.addEventListener('click', _toggleSnap);
  document.getElementById('btn-flip')?.addEventListener('click', () => emit('flipBoard', {}));
  document.getElementById('btn-align')?.addEventListener('click', () => emit('alignSelected', {}));
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => emit('zoom', { delta: 0.25 }));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => emit('zoom', { delta: -0.25 }));
  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => emit('zoomFit', {}));
  document.getElementById('zoom-display')?.addEventListener('click', () => emit('zoomFit', {}));

  // Board name sync
  const boardInput = document.getElementById('board-name-input');
  const boardDisplay = document.getElementById('board-name-display');
  boardInput?.addEventListener('input', () => {
    if (boardDisplay) boardDisplay.textContent = boardInput.value || 'Untitled Board';
    document.title = `${boardInput.value || 'Untitled Board'} — PCB Mapper v2`;
    emit('boardNameChange', { name: boardInput.value });
  });

  // Layer selector
  document.getElementById('layer-select')?.addEventListener('change', (e) => {
    emit('layerChange', { layer: e.target.value });
  });
}

export function setZoomDisplay(pct) {
  const el = document.getElementById('zoom-display');
  if (el) el.textContent = `${Math.round(pct)}%`;
}

export function setBoardName(name) {
  const input = document.getElementById('board-name-input');
  const display = document.getElementById('board-name-display');
  if (input) input.value = name;
  if (display) display.textContent = name;
  document.title = `${name} — PCB Mapper v2`;
}

export function setCursorPosition(px, py, mmX, mmY) {
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setEl('status-x', Math.round(px));
  setEl('status-y', Math.round(py));
  setEl('status-mm-x', mmX.toFixed(2));
  setEl('status-mm-y', mmY.toFixed(2));
}

export function setSelectionInfo(text) {
  const el = document.getElementById('status-selection-info');
  if (el) el.innerHTML = text ? `<span class="status-value">${text}</span>` : '<span class="status-label">—</span>';
}

export function setAutoSaveState(state) {
  // state: 'saved' | 'saving' | 'error'
  const bar = document.getElementById('status-autosave');
  const ind = document.getElementById('autosave-indicator');
  const text = document.getElementById('autosave-text');

  const labels = { saved: 'Saved', saving: 'Saving…', error: 'Save failed' };

  [bar, ind].forEach(el => {
    if (!el) return;
    el.classList.toggle('saving', state === 'saving');
    el.classList.toggle('error', state === 'error');
  });
  if (text) text.textContent = labels[state] || 'Saved';
}

// ═══════════════════════════════════════════════════════════════════
// Resizable Right Panel
// ═══════════════════════════════════════════════════════════════════

export function initResizablePanel() {
  const handle = document.getElementById('panel-resize-handle');
  const panel = document.getElementById('right-panel');
  if (!handle || !panel) return;

  let startX = 0;
  let startW = 0;

  function onMouseMove(e) {
    const delta = startX - e.clientX;
    const newW = Math.min(
      Math.max(startW + delta, 200),
      window.innerWidth * 0.45
    );
    panel.style.setProperty('--panel-width', `${newW}px`);
    panel.style.width = `${newW}px`;
  }

  function onMouseUp() {
    _panelResizing = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  handle.addEventListener('mousedown', (e) => {
    _panelResizing = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  // Keyboard resize
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 20 : 5;
    const current = panel.offsetWidth;
    if (e.key === 'ArrowLeft') {
      panel.style.width = `${Math.min(current + step, window.innerWidth * 0.45)}px`;
    } else if (e.key === 'ArrowRight') {
      panel.style.width = `${Math.max(current - step, 200)}px`;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// Modal Management
// ═══════════════════════════════════════════════════════════════════

export function openModal(modalId) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById(modalId);
  if (!overlay || !modal) return;

  closeAllModals();

  overlay.hidden = false;
  modal.hidden = false;
  _activeModal = modalId;

  // Focus first input
  requestAnimationFrame(() => {
    const first = modal.querySelector('input, select, textarea, button:not(.modal-close)');
    first?.focus();
  });
}

export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.hidden = true;
  if (_activeModal === modalId) {
    _activeModal = null;
    document.getElementById('modal-overlay').hidden = true;
  }
}

export function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.hidden = true);
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.hidden = true;
  _activeModal = null;
}

function _initModals() {
  // Close on overlay click
  const overlay = document.getElementById('modal-overlay');
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeAllModals();
  });

  // Close buttons
  document.querySelectorAll('[data-modal-close]').forEach(btn => {
    btn.addEventListener('click', closeAllModals);
  });

  // New board form
  document.getElementById('btn-create-board')?.addEventListener('click', () => {
    const name = document.getElementById('new-board-name').value.trim() || 'Untitled Board';
    const w = parseFloat(document.getElementById('new-board-w').value) || 100;
    const h = parseFloat(document.getElementById('new-board-h').value) || 80;
    const layers = parseInt(document.querySelector('.segment-btn.active')?.dataset.layers) || 2;
    const notes = document.getElementById('new-board-notes').value;
    closeAllModals();
    _launchApp({ name, w, h, layers, notes });
    emit('newBoard', { name, w, h, layers, notes });
  });

  // Layer count segment buttons
  document.querySelectorAll('#layer-count-select .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#layer-count-select .segment-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Component modal
  document.getElementById('btn-place-component')?.addEventListener('click', () => {
    const data = {
      label:    document.getElementById('comp-label').value.trim(),
      type:     document.getElementById('comp-type').value,
      pins:     parseInt(document.getElementById('comp-pins').value) || 8,
      value:    document.getElementById('comp-value').value.trim(),
      package:  document.getElementById('comp-package').value.trim(),
      datasheet: document.getElementById('comp-datasheet').value.trim(),
    };
    closeAllModals();
    emit('placeComponent', data);
  });

  // Pour modal
  const pourOpacity = document.getElementById('pour-opacity');
  const pourOpacityVal = document.getElementById('pour-opacity-val');
  pourOpacity?.addEventListener('input', () => {
    if (pourOpacityVal) pourOpacityVal.textContent = `${pourOpacity.value}%`;
  });

  document.querySelectorAll('#pour-color-presets .color-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pour-color-presets .color-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const colorInput = document.getElementById('pour-color');
      if (colorInput) colorInput.value = btn.dataset.color;
    });
  });

  document.getElementById('btn-create-pour')?.addEventListener('click', () => {
    const data = {
      label:   document.getElementById('pour-label').value.trim(),
      type:    document.getElementById('pour-type').value,
      net:     document.getElementById('pour-net').value,
      color:   document.getElementById('pour-color').value,
      opacity: parseInt(document.getElementById('pour-opacity').value) / 100,
    };
    closeAllModals();
    emit('createPour', data);
  });

  // Landing page buttons
  document.getElementById('btn-new-board')?.addEventListener('click', () => openModal('modal-new-board'));
  document.getElementById('btn-open-file')?.addEventListener('click', () => _triggerFileOpen('.pcbmap,.json'));
  document.getElementById('btn-import-image')?.addEventListener('click', () => _triggerFileOpen('image/*', 'top'));
  document.getElementById('btn-shortcuts-landing')?.addEventListener('click', () => openModal('modal-shortcuts'));
  document.getElementById('btn-about-landing')?.addEventListener('click', () => openModal('modal-about'));

  // DRC run button
  document.getElementById('btn-run-drc')?.addEventListener('click', () => {
    const rules = {
      clearance:  parseFloat(document.getElementById('drc-clearance')?.value) || 0.2,
      traceWidth: parseFloat(document.getElementById('drc-trace-width')?.value) || 0.15,
      drillSize:  parseFloat(document.getElementById('drc-drill-size')?.value) || 0.3,
    };
    emit('runDrc', rules);
    showToast('Running DRC…', 'info');
  });

  // Test log
  document.getElementById('btn-add-test')?.addEventListener('click', _addTestEntry);

  // Export test log
  document.getElementById('btn-export-test-log')?.addEventListener('click', () => {
    emit('exportTestLog', {});
    showToast('Test log exported', 'success');
  });
}

export function renderDrcResults(results) {
  const container = document.getElementById('drc-results');
  const summary = document.getElementById('drc-summary');
  if (!container) return;

  const errors = results.filter(r => r.level === 'error').length;
  const warnings = results.filter(r => r.level === 'warning').length;

  if (summary) {
    summary.textContent = results.length === 0
      ? '✓ No issues'
      : `${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}`;
    summary.style.color = errors > 0 ? 'var(--error)' : warnings > 0 ? 'var(--warning)' : 'var(--success)';
  }

  if (results.length === 0) {
    container.innerHTML = '<div class="drc-item drc-item--pass"><span class="drc-item-icon">✓</span><div class="drc-item-text">All design rules passed</div></div>';
    return;
  }

  container.innerHTML = results.map(r => `
    <div class="drc-item drc-item--${r.level}">
      <span class="drc-item-icon">${r.level === 'error' ? '✕' : r.level === 'warning' ? '⚠' : '✓'}</span>
      <div class="drc-item-text">
        ${r.message}
        ${r.location ? `<div class="drc-item-loc">${r.location}</div>` : ''}
      </div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════════
// Test Log
// ═══════════════════════════════════════════════════════════════════

let _testLog = [];

function _addTestEntry() {
  const ref = document.getElementById('test-ref')?.value.trim();
  const status = document.getElementById('test-status')?.value;
  const note = document.getElementById('test-note')?.value.trim();

  if (!ref) {
    showToast('Enter a component reference', 'warning');
    return;
  }

  const entry = { ref, status, note, time: new Date().toISOString() };
  _testLog.push(entry);
  _renderTestLog();

  // Clear inputs
  const refInput = document.getElementById('test-ref');
  const noteInput = document.getElementById('test-note');
  if (refInput) refInput.value = '';
  if (noteInput) noteInput.value = '';

  emit('testLogEntry', entry);
}

function _renderTestLog() {
  const list = document.getElementById('test-log-list');
  if (!list) return;

  if (_testLog.length === 0) {
    list.innerHTML = '<div class="parts-empty">No test entries yet</div>';
    return;
  }

  list.innerHTML = [..._testLog].reverse().map((e, i) => `
    <div class="test-entry" data-index="${_testLog.length - 1 - i}">
      <span class="test-entry-ref">${_escHtml(e.ref)}</span>
      <span class="test-badge test-badge--${e.status}">${e.status.toUpperCase()}</span>
      <span class="test-entry-note" title="${_escHtml(e.note)}">${_escHtml(e.note) || '—'}</span>
    </div>
  `).join('');
}

export function getTestLog() {
  return [..._testLog];
}

export function clearTestLog() {
  _testLog = [];
  _renderTestLog();
}

// ═══════════════════════════════════════════════════════════════════
// Resistor Calculator
// ═══════════════════════════════════════════════════════════════════

const BAND_COLORS = {
  0:  { name: 'Black',  hex: '#1a1a1a' },
  1:  { name: 'Brown',  hex: '#964b00' },
  2:  { name: 'Red',    hex: '#cc0000' },
  3:  { name: 'Orange', hex: '#ff8000' },
  4:  { name: 'Yellow', hex: '#cccc00' },
  5:  { name: 'Green',  hex: '#00a000' },
  6:  { name: 'Blue',   hex: '#0000cc' },
  7:  { name: 'Violet', hex: '#8000c0' },
  8:  { name: 'Gray',   hex: '#808080' },
  9:  { name: 'White',  hex: '#f0f0f0' },
};

const MULT_COLORS = {
  1:        '#1a1a1a',
  10:       '#964b00',
  100:      '#cc0000',
  1000:     '#ff8000',
  10000:    '#cccc00',
  100000:   '#00a000',
  1000000:  '#0000cc',
  10000000: '#8000c0',
  0.1:      '#c0a000',
  0.01:     '#b0b0b0',
};

const TOL_COLORS = {
  '±1%':   '#964b00',
  '±2%':   '#cc0000',
  '±0.5%': '#00a000',
  '±0.25%':'#0000cc',
  '±0.1%': '#8000c0',
  '±0.05%':'#808080',
  '±5%':   '#c0a000',
  '±10%':  '#b0b0b0',
  '±20%':  'transparent',
};

function _formatOhms(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toPrecision(4).replace(/\.?0+$/, '')} MΩ`;
  if (value >= 1_000)    return `${(value / 1_000).toPrecision(4).replace(/\.?0+$/, '')} kΩ`;
  return `${value.toPrecision(4).replace(/\.?0+$/, '')} Ω`;
}

function _calcResistor() {
  const isFive = _calcBandCount === 5;

  const b1 = parseInt(document.getElementById('calc-band1')?.value ?? 1);
  const b2 = parseInt(document.getElementById('calc-band2')?.value ?? 0);
  const b3 = isFive ? parseInt(document.getElementById('calc-band3')?.value ?? 0) : null;
  const mult = parseFloat(document.getElementById('calc-mult')?.value ?? 10);
  const tol = document.getElementById('calc-tol')?.value ?? '±5%';

  let value;
  if (isFive) {
    value = (b1 * 100 + b2 * 10 + (b3 ?? 0)) * mult;
  } else {
    value = (b1 * 10 + b2) * mult;
  }

  const display = document.getElementById('calc-value-display');
  const tolDisplay = document.getElementById('calc-tol-display');
  if (display) display.textContent = _formatOhms(value);
  if (tolDisplay) tolDisplay.textContent = tol;

  // Update SVG band colors
  _updateResistorBand('band-1', BAND_COLORS[b1]?.hex ?? '#888');
  _updateResistorBand('band-2', BAND_COLORS[b2]?.hex ?? '#888');

  const multColor = MULT_COLORS[mult] ?? '#888';
  const tolColor = TOL_COLORS[tol] ?? 'transparent';

  if (isFive && b3 !== null) {
    _updateResistorBand('band-3', BAND_COLORS[b3]?.hex ?? '#888');
    _setResistorBandPos('band-3', true);
    _setResistorBandPos('band-4', true);
    _updateResistorBand('band-4', multColor);
    _setResistorBandPos('band-5', true);
    _updateResistorBand('band-5', tolColor);
  } else {
    _setResistorBandPos('band-3', false);
    _updateResistorBand('band-3', 'transparent');
    _setResistorBandPos('band-4', false);
    _updateResistorBand('band-4', multColor);
    _setResistorBandPos('band-5', false);
    _updateResistorBand('band-5', tolColor);
  }
}

function _updateResistorBand(id, color) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('fill', color);
}

function _setResistorBandPos(id, fiveBand) {
  const el = document.getElementById(id);
  if (!el) return;

  const positions = {
    'band-3': { four: { x: '92', opacity: '0' }, five: { x: '88', opacity: '1' } },
    'band-4': { four: { x: '110', opacity: '1' }, five: { x: '106', opacity: '1' } },
    'band-5': { four: { x: '130', opacity: '0' }, five: { x: '126', opacity: '1' } },
  };

  const pos = positions[id];
  if (!pos) return;

  const p = fiveBand ? pos.five : pos.four;
  el.setAttribute('x', p.x);
  el.setAttribute('opacity', p.opacity);
}

function _initResistorCalc() {
  // Band count toggle
  document.querySelectorAll('.band-btn[data-bands]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.band-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _calcBandCount = parseInt(btn.dataset.bands);

      const band3Row = document.getElementById('band3-row');
      if (band3Row) band3Row.hidden = _calcBandCount !== 5;

      _calcResistor();
    });
  });

  // Band selectors
  ['calc-band1', 'calc-band2', 'calc-band3', 'calc-mult', 'calc-tol'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _calcResistor);
  });

  // SMD decoder
  document.getElementById('btn-smd-decode')?.addEventListener('click', _decodeSmd);
  document.getElementById('smd-code-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _decodeSmd();
  });

  // Reverse lookup
  document.getElementById('btn-reverse-lookup')?.addEventListener('click', _reverseLookup);
  document.getElementById('reverse-value-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _reverseLookup();
  });

  // Initial calculation
  _calcResistor();
}

function _decodeSmd() {
  const code = document.getElementById('smd-code-input')?.value.trim().toUpperCase();
  const result = document.getElementById('smd-result');
  if (!result) return;

  if (!code) {
    result.textContent = '';
    return;
  }

  let value = null;
  let formatted = '';

  // 4-digit EIA-96 style: e.g. "1002" = 10 × 10² = 1000Ω
  if (/^\d{4}$/.test(code)) {
    const base = parseInt(code.slice(0, 3));
    const exp = parseInt(code[3]);
    value = base * Math.pow(10, exp);
    formatted = _formatOhms(value);
  }
  // 3-digit: e.g. "103" = 10 × 10³ = 10kΩ
  else if (/^\d{3}$/.test(code)) {
    const base = parseInt(code.slice(0, 2));
    const exp = parseInt(code[2]);
    value = base * Math.pow(10, exp);
    formatted = _formatOhms(value);
  }
  // R notation: "4R7" = 4.7Ω, "1R0" = 1Ω
  else if (/^\d+R\d*$/.test(code)) {
    const parts = code.split('R');
    value = parseFloat(`${parts[0]}.${parts[1] || '0'}`);
    formatted = _formatOhms(value);
  }
  // K notation: "4K7" = 4.7kΩ
  else if (/^\d+K\d*$/.test(code)) {
    const parts = code.split('K');
    value = parseFloat(`${parts[0]}.${parts[1] || '0'}`) * 1000;
    formatted = _formatOhms(value);
  }
  // M notation: "1M0" = 1MΩ
  else if (/^\d+M\d*$/.test(code)) {
    const parts = code.split('M');
    value = parseFloat(`${parts[0]}.${parts[1] || '0'}`) * 1_000_000;
    formatted = _formatOhms(value);
  }

  if (value !== null) {
    result.textContent = `= ${formatted}`;
    result.style.color = 'var(--success)';
  } else {
    result.textContent = 'Unknown code format';
    result.style.color = 'var(--error)';
  }
}

function _reverseLookup() {
  const val = parseFloat(document.getElementById('reverse-value-input')?.value);
  const unit = parseFloat(document.getElementById('reverse-unit')?.value ?? 1);
  const result = document.getElementById('reverse-result');
  if (!result) return;

  if (isNaN(val) || val <= 0) {
    result.textContent = '';
    return;
  }

  const ohms = val * unit;

  // Find best E24 value
  const e24 = [1.0,1.1,1.2,1.3,1.5,1.6,1.8,2.0,2.2,2.4,2.7,3.0,
               3.3,3.6,3.9,4.3,4.7,5.1,5.6,6.2,6.8,7.5,8.2,9.1];

  let best = null, bestErr = Infinity;
  for (let decade = -1; decade <= 7; decade++) {
    for (const base of e24) {
      const candidate = base * Math.pow(10, decade);
      const err = Math.abs(candidate - ohms) / ohms;
      if (err < bestErr) {
        bestErr = err;
        best = candidate;
      }
    }
  }

  if (best !== null) {
    const errPct = (bestErr * 100).toFixed(1);
    result.textContent = `≈ ${_formatOhms(best)} (E24, ${errPct}% off)`;
    result.style.color = bestErr < 0.02 ? 'var(--success)' : 'var(--warning)';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Part Group Collapse
// ═══════════════════════════════════════════════════════════════════

function _initPartGroups() {
  document.querySelectorAll('.part-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const group = header.closest('.part-group');
      group?.classList.toggle('collapsed');
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Parts Panel Update
// ═══════════════════════════════════════════════════════════════════

export function updatePartsPanel(components) {
  const byType = {};
  for (const comp of components) {
    const t = comp.type || 'Other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(comp);
  }

  // Update counts and lists per group
  document.querySelectorAll('.part-group[data-type]').forEach(group => {
    const type = group.dataset.type;
    const typeKey = _mapTypeToGroup(type);
    const items = byType[typeKey] || [];
    const countEl = group.querySelector('.part-count');
    const bodyEl = group.querySelector('.part-group-body');

    if (countEl) countEl.textContent = items.length;
    if (!bodyEl) return;

    if (items.length === 0) {
      bodyEl.innerHTML = `<div class="parts-empty">No ${type}s placed</div>`;
    } else {
      bodyEl.innerHTML = items.map(c => `
        <div class="part-item" data-id="${_escHtml(c.id)}">
          <span class="part-ref">${_escHtml(c.label)}</span>
          <span class="part-type">${_escHtml(c.package || c.type)}</span>
          <span class="part-value">${_escHtml(c.value || '')}</span>
        </div>
      `).join('');

      bodyEl.querySelectorAll('.part-item').forEach(item => {
        item.addEventListener('click', () => emit('selectComponent', { id: item.dataset.id }));
      });
    }
  });
}

function _mapTypeToGroup(type) {
  const ic = ['IC', 'Microcontroller', 'MCU', 'CPU', 'FPGA', 'Memory'];
  const passive = ['Resistor', 'Capacitor', 'Inductor', 'Crystal', 'Ferrite', 'Fuse'];
  const connector = ['Connector', 'Header', 'USB', 'Jack', 'Socket'];
  if (ic.includes(type)) return 'IC';
  if (passive.includes(type)) return 'Passive';
  if (connector.includes(type)) return 'Connector';
  return type;
}

// ═══════════════════════════════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════════════════════════════

const TOAST_ICONS = {
  success: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>',
  warning: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2L14 13H2L8 2z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/></svg>',
  error:   '<svg class="toast-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg>',
  info:    '<svg class="toast-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r="0.5" fill="currentColor"/></svg>',
};

export function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    ${TOAST_ICONS[type] || TOAST_ICONS.info}
    <span class="toast-message">${_escHtml(message)}</span>
    <button class="toast-close" aria-label="Dismiss">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="10" height="10">
        <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
      </svg>
    </button>
  `;

  const dismiss = () => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  toast.querySelector('.toast-close')?.addEventListener('click', dismiss);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }

  return { dismiss };
}

// ═══════════════════════════════════════════════════════════════════
// Keyboard Shortcuts
// ═══════════════════════════════════════════════════════════════════

const TOOL_SHORTCUTS = {
  'v': 'select', 'h': 'pan', 'm': 'marker', 'c': 'component',
  'p': 'pad', 'n': 'net', 't': 'trace', 'b': 'bus',
  'f': 'pour', 'x': 'punchout', 'o': 'outline', 'd': 'measure',
};

function _initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Skip when typing in inputs
    if (_isInputFocused(e.target)) return;

    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // Escape — close modals or deselect
    if (e.key === 'Escape') {
      if (_activeModal) {
        closeAllModals();
      } else {
        emit('deselect', {});
      }
      return;
    }

    // Modal shortcuts pass-through
    if (_activeModal) return;

    // ? — show shortcuts
    if (key === '?' || (shift && key === '/')) {
      openModal('modal-shortcuts');
      e.preventDefault();
      return;
    }

    // Ctrl shortcuts
    if (ctrl) {
      switch (key) {
        case 'n': e.preventDefault(); openModal('modal-new-board'); break;
        case 'o': e.preventDefault(); _triggerFileOpen('.pcbmap,.json'); break;
        case 's': e.preventDefault(); emit(shift ? 'saveAs' : 'save', {}); break;
        case 'z': e.preventDefault(); emit(shift ? 'redo' : 'undo', {}); break;
        case 'y': e.preventDefault(); emit('redo', {}); break;
        case 'a': e.preventDefault(); emit('selectAll', {}); break;
        case 'i': e.preventDefault(); _triggerFileOpen('image/*', 'top'); break;
        case 'e': e.preventDefault(); emit('export', { format: 'bom' }); break;
        case 'f': e.preventDefault(); emit('flipBoard', {}); break;
        case 'd': e.preventDefault(); emit('duplicate', {}); break;
        case '3': e.preventDefault(); emit('view3d', {}); break;
        case '0': e.preventDefault(); emit('zoomFit', {}); break;
        case '=':
        case '+': e.preventDefault(); emit('zoom', { delta: 0.25 }); break;
        case '-': e.preventDefault(); emit('zoom', { delta: -0.25 }); break;
      }
      return;
    }

    // Tool shortcuts
    if (TOOL_SHORTCUTS[key]) {
      const tool = TOOL_SHORTCUTS[key];
      if (tool === 'component') {
        setActiveTool(tool);
        openModal('modal-component');
      } else if (tool === 'pour') {
        setActiveTool(tool);
        openModal('modal-pour');
      } else {
        setActiveTool(tool);
      }
      return;
    }

    // View shortcuts
    switch (key) {
      case 'g': _toggleGrid(); break;
      case 'r': _toggleRulers(); break;
      case 's': _toggleSnap(); break;
      case 'delete':
      case 'backspace': emit('deleteSelected', {}); break;
      case 'home': emit('resetView', {}); break;
      case 'tab':
        e.preventDefault();
        emit('cycleSelection', { reverse: shift });
        break;
      case 'arrowup':    emit('nudge', { dx: 0, dy: -1, big: shift }); e.preventDefault(); break;
      case 'arrowdown':  emit('nudge', { dx: 0, dy:  1, big: shift }); e.preventDefault(); break;
      case 'arrowleft':  emit('nudge', { dx: -1, dy: 0, big: shift }); e.preventDefault(); break;
      case 'arrowright': emit('nudge', { dx:  1, dy: 0, big: shift }); e.preventDefault(); break;
    }
  });

  // Space to toggle pan while held
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !_isInputFocused(e.target) && !_activeModal) {
      e.preventDefault();
      if (_currentTool !== 'pan') {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        const prevTool = _currentTool;
        _currentTool = 'pan';
        const canvas = document.getElementById('canvas-container');
        if (canvas) canvas.dataset.tool = 'pan';
        emit('toolChange', { tool: 'pan', prev: prevTool, temporary: true });
        document.addEventListener('keyup', function onUp(ev) {
          if (ev.key === ' ') {
            setActiveTool(prevTool);
            document.removeEventListener('keyup', onUp);
          }
        });
      }
    }
  });
}

function _isInputFocused(target) {
  return target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

// ═══════════════════════════════════════════════════════════════════
// Landing Page
// ═══════════════════════════════════════════════════════════════════

function _launchApp(boardConfig) {
  const landing = document.getElementById('landing-overlay');
  const app = document.getElementById('app');
  if (landing) landing.hidden = true;
  if (app) app.hidden = false;
  if (boardConfig) setBoardName(boardConfig.name);
}

export function showLanding() {
  const landing = document.getElementById('landing-overlay');
  const app = document.getElementById('app');
  if (landing) landing.hidden = false;
  if (app) app.hidden = true;
}

export function renderRecentBoards(boards) {
  const list = document.getElementById('recent-boards-list');
  const empty = document.getElementById('recent-empty-state');
  const menuRecent = document.getElementById('menu-recent');
  const menuEmpty = document.getElementById('recent-menu-empty');

  if (!list) return;

  if (!boards || boards.length === 0) {
    if (empty) empty.hidden = false;
    list.innerHTML = '';
    list.appendChild(empty);
    if (menuEmpty) menuEmpty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;

  list.innerHTML = boards.map(b => `
    <div class="recent-board-item" data-path="${_escHtml(b.path || '')}">
      <div class="recent-thumb">
        ${b.thumbnail
          ? `<img src="${_escHtml(b.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:cover"/>`
          : `<svg viewBox="0 0 24 24" fill="none" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="2" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="3 2"/></svg>`
        }
      </div>
      <div class="recent-board-info">
        <div class="recent-board-name">${_escHtml(b.name)}</div>
        <div class="recent-board-meta">${b.date ? _formatDate(b.date) : ''}</div>
      </div>
      <div class="recent-board-stats">
        ${b.components != null ? `${b.components} parts` : ''}
        ${b.markers != null ? `· ${b.markers} markers` : ''}
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.recent-board-item').forEach(item => {
    item.addEventListener('click', () => {
      emit('openRecentBoard', { path: item.dataset.path });
    });
  });

  // Populate menu recent
  if (menuRecent) {
    if (menuEmpty) menuEmpty.hidden = true;
    boards.slice(0, 8).forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'menu-action';
      btn.textContent = b.name;
      btn.addEventListener('click', () => emit('openRecentBoard', { path: b.path }));
      menuRecent.appendChild(btn);
    });
  }

  document.getElementById('btn-clear-recent')?.addEventListener('click', () => {
    emit('clearRecentBoards', {});
    renderRecentBoards([]);
  });
}

function _formatDate(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Drag & Drop on canvas
// ═══════════════════════════════════════════════════════════════════

function _initDragDrop() {
  const container = document.getElementById('canvas-container');
  const dropzone = document.getElementById('canvas-dropzone');
  if (!container) return;

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
    if (dropzone) dropzone.hidden = false;
  });

  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
    if (dropzone) dropzone.hidden = true;
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    if (dropzone) dropzone.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (file) {
      const meta = file.type.startsWith('image/') ? 'top' : undefined;
      emit('fileOpen', { file, meta });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function _escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════
// Main Init
// ═══════════════════════════════════════════════════════════════════

export function initApp() {
  _initToolbar();
  _initMenuBar();
  _initPanelTabs();
  _initTopActionBar();
  _initModals();
  _initKeyboardShortcuts();
  _initResistorCalc();
  _initPartGroups();
  _initDragDrop();
  initResizablePanel();

  // Set initial tool state
  setActiveTool('select');

  // Set initial panel tab
  switchPanelTab('parts');
}

export {
  _escHtml as escHtml,
};
