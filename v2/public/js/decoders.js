/**
 * PCB Mapper v2 — Decoders
 * Resistor color decoder (4/5 band), reverse lookup, SMD code decoder.
 */

// ─── Color data ───────────────────────────────────────────────────────────────
const R_COLORS = {
  black:  { val: 0, mul: 1,    hex: '#222222', text: '#fff' },
  brown:  { val: 1, mul: 10,   hex: '#8B4513', text: '#fff', tol: '±1%' },
  red:    { val: 2, mul: 100,  hex: '#FF0000', text: '#fff', tol: '±2%' },
  orange: { val: 3, mul: 1e3,  hex: '#FF8C00', text: '#000' },
  yellow: { val: 4, mul: 1e4,  hex: '#FFD700', text: '#000' },
  green:  { val: 5, mul: 1e5,  hex: '#228B22', text: '#fff', tol: '±0.5%' },
  blue:   { val: 6, mul: 1e6,  hex: '#0000FF', text: '#fff', tol: '±0.25%' },
  violet: { val: 7, mul: 1e7,  hex: '#8B00FF', text: '#fff', tol: '±0.1%' },
  grey:   { val: 8, mul: 1e8,  hex: '#808080', text: '#fff', tol: '±0.05%' },
  white:  { val: 9, mul: 1e9,  hex: '#FFFFFF', text: '#000' },
  gold:   { mul: 0.1,          hex: '#FFD700', text: '#000', tol: '±5%' },
  silver: { mul: 0.01,         hex: '#C0C0C0', text: '#000', tol: '±10%' },
};

const DIGIT_NAMES  = ['black','brown','red','orange','yellow','green','blue','violet','grey','white'];
const MUL_NAMES    = ['black','brown','red','orange','yellow','green','blue','violet','grey','white','gold','silver'];
const TOL_NAMES    = ['brown','red','green','blue','violet','grey','gold','silver'];

// EIA-96 table (index 1..96 → base value)
const EIA96_VAL = [0,100,102,105,107,110,113,115,118,121,124,127,130,133,137,140,143,147,
  150,154,158,162,165,169,174,178,182,187,191,196,200,205,210,215,221,226,232,237,243,249,
  255,261,267,274,280,287,294,301,309,316,324,332,340,348,357,365,374,383,392,402,412,422,
  432,442,453,464,475,487,499,511,523,536,549,562,576,590,604,619,634,649,665,681,698,715,
  732,750,768,787,806,825,845,866,887,909,931,953,976];
const EIA_MUL_MAP = { Z:0.001, Y:0.01, R:0.01, X:0.1, A:1, B:10, C:100, D:1000, E:10000, F:100000 };

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * initDecoders — inject decoder UI into containers.
 * @param {HTMLElement} resistorContainer
 * @param {HTMLElement} smdContainer
 */
export function initDecoders(resistorContainer, smdContainer) {
  if (resistorContainer) buildResistorUI(resistorContainer);
  if (smdContainer) buildSMDUI(smdContainer);
}

/**
 * decodeResistor — given band count and color names, return value info.
 * @param {number} bandCount - 4 or 5
 * @param {string[]} colors - array of color names (length = bandCount)
 * @returns {{ value: number, tolerance: string, formatted: string }}
 */
export function decodeResistor(bandCount, colors) {
  const dc = bandCount === 5 ? 3 : 2;
  if (colors.length < dc + 2) return { value: 0, tolerance: '?', formatted: '?' };
  let val = 0;
  for (let i = 0; i < dc; i++) {
    const c = R_COLORS[colors[i]];
    if (!c || c.val === undefined) return { value: 0, tolerance: '?', formatted: 'Invalid color' };
    val = val * 10 + c.val;
  }
  const mulColor = R_COLORS[colors[dc]];
  const tolColor = R_COLORS[colors[dc + 1]];
  if (!mulColor || !tolColor) return { value: 0, tolerance: '?', formatted: 'Invalid color' };
  val *= mulColor.mul;
  const tolerance = tolColor.tol || '?';
  return { value: val, tolerance, formatted: fmtR(val) + ' ' + tolerance };
}

/**
 * reverseResistor — given a value string and band count, return color names.
 * @param {string|number} valueStr - e.g. "4.7k", "22000", "100"
 * @param {number} bandCount - 4 or 5
 * @returns {string[]} array of color names
 */
export function reverseResistor(valueStr, bandCount = 4) {
  let val = parseFloat(String(valueStr).toLowerCase()
    .replace(/k/g, 'e3').replace(/m(?!a)/g, 'e6').replace(/r/g, '.'));
  if (isNaN(val) || val <= 0) return [];
  const dc = bandCount === 5 ? 3 : 2;

  // Find multiplier
  const ranges2 = [[1e9,9],[1e8,8],[1e7,7],[1e6,6],[1e5,5],[1e4,4],[1e3,3],[100,2],[10,1],[1,0],[0.1,10],[0.01,11]];
  const ranges3 = [[1e9,7],[1e8,6],[1e7,5],[1e6,4],[1e5,3],[1e4,2],[1e3,1],[100,0],[10,10],[1,11]];
  const ranges = dc === 2 ? ranges2 : ranges3;
  let digits, mulIdx;
  for (const [thresh, mi] of ranges) {
    if (val >= thresh) { digits = Math.round(val / (mi <= 9 ? Math.pow(10, mi + dc - 2) : mi === 10 ? 0.1 : 0.01)); mulIdx = mi; break; }
  }
  if (digits === undefined) { digits = Math.round(val * 100); mulIdx = 11; }
  const dStr = String(digits).padStart(dc, '0');
  const result = [];
  for (let i = 0; i < dc; i++) result.push(DIGIT_NAMES[parseInt(dStr[i])] || 'black');
  result.push(MUL_NAMES[mulIdx] || 'black');
  return result;
}

/**
 * decodeSMD — decode SMD component marking code.
 * @param {string} code
 * @returns {Array<{type: string, value: string}>}
 */
export function decodeSMD(code) {
  const raw = code.trim();
  if (!raw) return [];
  const upper = raw.toUpperCase();
  const results = [];

  // EIA-96 (2 digits + letter): 01A = 100Ω, 68X = 49.9kΩ
  if (/^\d{2}[A-Z]$/.test(upper)) {
    const idx = parseInt(upper.slice(0, 2));
    const letter = upper[2];
    if (idx >= 1 && idx <= 96 && EIA_MUL_MAP[letter] !== undefined) {
      const val = EIA96_VAL[idx] * EIA_MUL_MAP[letter];
      results.push({ type: 'Resistor (EIA-96)', value: fmtR(val) });
    }
  }

  // 3-digit resistor: 103 = 10kΩ
  if (/^\d{3}$/.test(upper)) {
    const d = parseInt(upper.slice(0, 2));
    const m = parseInt(upper[2]);
    const val = d * Math.pow(10, m);
    if (val > 0) results.push({ type: 'Resistor (3-digit)', value: fmtR(val) });
    // Also try as capacitor
    const pf = d * Math.pow(10, m);
    if (pf > 0) results.push({ type: 'Capacitor (3-digit)', value: fmtC(pf) });
  }

  // 4-digit resistor: 1001 = 1kΩ
  if (/^\d{4}$/.test(upper)) {
    const d = parseInt(upper.slice(0, 3));
    const m = parseInt(upper[3]);
    const val = d * Math.pow(10, m);
    if (val > 0) results.push({ type: 'Resistor (4-digit)', value: fmtR(val) });
  }

  // R notation: 4R7, R47, 47R
  if (/^(\d*)R(\d+)$/i.test(upper) || /^(\d+)R(\d*)$/i.test(upper)) {
    const val = parseFloat(upper.replace(/R/i, '.'));
    if (!isNaN(val) && val > 0) results.push({ type: 'Resistor (R-notation)', value: fmtR(val) });
  }

  // Capacitor with letter: 1n0, 4u7, 2p2
  if (/^[\d.]+[pnuμ][\d]*$/i.test(raw)) {
    const match = raw.match(/^([\d.]*?)([pnuμ])([\d]*)$/i);
    if (match) {
      const num = parseFloat((match[1] || '0') + (match[3] ? '.' + match[3] : ''));
      const unitChar = match[2].toLowerCase();
      const muls = { p: 1, n: 1e3, u: 1e6, 'μ': 1e6 };
      const pf = num * (muls[unitChar] || 1);
      if (pf > 0) results.push({ type: 'Capacitor', value: fmtC(pf) });
    }
  }

  // Deduplicate
  const seen = new Set();
  return results.filter(r => { const k = r.type + r.value; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ─── UI builders ──────────────────────────────────────────────────────────────
function buildResistorUI(container) {
  container.innerHTML = `
    <div class="psection">
      <h3>Resistor Color Decoder</h3>
      <div style="margin-bottom:6px">
        <label style="font-size:10px;color:#888">Band count</label>
        <select id="res-bands" style="background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:3px;padding:2px;font-size:11px;width:100%">
          <option value="4">4-band</option>
          <option value="5">5-band</option>
        </select>
      </div>
      <div id="res-inputs"></div>
      <div id="res-visual" style="display:flex;align-items:center;justify-content:center;margin:8px 0;height:30px;background:#2a2a3e;border-radius:4px;gap:3px;padding:0 20px"></div>
      <div id="res-result" style="background:#1a1a2e;padding:8px;border-radius:4px;margin-top:6px;font-size:13px;color:#4488ff;text-align:center;font-weight:bold">—</div>
      <div style="margin-top:10px">
        <h3 style="color:#e94560;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Value → Colors</h3>
        <input id="res-val-input" placeholder="e.g. 4.7k, 22k, 100" style="background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:4px;padding:4px 8px;font-size:12px;width:100%">
        <div id="res-reverse" style="margin-top:6px;color:#888;font-size:11px"></div>
      </div>
    </div>
  `;

  const bandsEl = container.querySelector('#res-bands');
  bandsEl.addEventListener('change', () => updateResistorInputs(container));
  container.querySelector('#res-val-input').addEventListener('input', e => updateReverseResistor(container, e.target.value));
  updateResistorInputs(container);
}

function updateResistorInputs(container) {
  const bandCount = parseInt(container.querySelector('#res-bands').value);
  const dc = bandCount === 5 ? 3 : 2;
  const inputsEl = container.querySelector('#res-inputs');
  let html = '';
  for (let i = 0; i < dc; i++) {
    html += `<div style="display:flex;gap:4px;margin:4px 0;align-items:center">
      <label style="font-size:10px;color:#888;width:50px;flex-shrink:0">Digit ${i + 1}</label>
      <select id="rb-d${i}" style="flex:1;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:3px;padding:2px 4px;font-size:11px">
        ${DIGIT_NAMES.map(n => `<option value="${n}" style="background:${R_COLORS[n].hex};color:${R_COLORS[n].text}">${n} (${R_COLORS[n].val})</option>`).join('')}
      </select></div>`;
  }
  html += `<div style="display:flex;gap:4px;margin:4px 0;align-items:center">
    <label style="font-size:10px;color:#888;width:50px;flex-shrink:0">Multiplier</label>
    <select id="rb-mul" style="flex:1;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:3px;padding:2px 4px;font-size:11px">
      ${MUL_NAMES.map(n => `<option value="${n}" style="background:${R_COLORS[n].hex};color:${R_COLORS[n].text}">${n} (×${R_COLORS[n].mul})</option>`).join('')}
    </select></div>`;
  html += `<div style="display:flex;gap:4px;margin:4px 0;align-items:center">
    <label style="font-size:10px;color:#888;width:50px;flex-shrink:0">Tolerance</label>
    <select id="rb-tol" style="flex:1;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:3px;padding:2px 4px;font-size:11px">
      ${TOL_NAMES.map(n => `<option value="${n}" style="background:${R_COLORS[n].hex};color:${R_COLORS[n].text}">${n} (${R_COLORS[n].tol})</option>`).join('')}
    </select></div>`;
  inputsEl.innerHTML = html;
  // Wire change events
  for (let i = 0; i < dc; i++) container.querySelector(`#rb-d${i}`).addEventListener('change', () => updateResistorResult(container, bandCount));
  container.querySelector('#rb-mul').addEventListener('change', () => updateResistorResult(container, bandCount));
  container.querySelector('#rb-tol').addEventListener('change', () => updateResistorResult(container, bandCount));
  updateResistorResult(container, bandCount);
}

function updateResistorResult(container, bandCount) {
  const dc = bandCount === 5 ? 3 : 2;
  const colors = [];
  for (let i = 0; i < dc; i++) {
    const sel = container.querySelector(`#rb-d${i}`);
    if (!sel) return;
    colors.push(sel.value);
  }
  const mulSel = container.querySelector('#rb-mul');
  const tolSel = container.querySelector('#rb-tol');
  if (!mulSel || !tolSel) return;
  colors.push(mulSel.value);
  const result = decodeResistor(bandCount, [...colors, tolSel.value]);
  container.querySelector('#res-result').textContent = result.formatted;
  // Visual resistor body
  const bandHexes = colors.map(c => R_COLORS[c]?.hex || '#888').concat([R_COLORS[tolSel.value]?.hex || '#888']);
  let vis = '<div style="width:20px;height:10px;background:#c4a67a;border-radius:0 3px 3px 0"></div><div style="display:flex;align-items:center;background:#c4a67a;border-radius:3px;padding:0 6px;height:20px;gap:4px">';
  bandHexes.forEach(hex => { vis += `<div style="width:8px;height:24px;border-radius:2px;border:1px solid rgba(255,255,255,0.15);background:${hex}"></div>`; });
  vis += '</div><div style="width:20px;height:10px;background:#c4a67a;border-radius:3px 0 0 3px"></div>';
  container.querySelector('#res-visual').innerHTML = vis;
}

function updateReverseResistor(container, input) {
  const reverseEl = container.querySelector('#res-reverse');
  if (!input.trim()) { reverseEl.innerHTML = ''; return; }
  const bandCount = parseInt(container.querySelector('#res-bands').value);
  const colors = reverseResistor(input, bandCount);
  if (!colors.length) { reverseEl.textContent = 'Invalid'; return; }
  reverseEl.innerHTML = colors.map(c => {
    const info = R_COLORS[c];
    return `<span title="${c}" style="display:inline-block;width:14px;height:14px;background:${info?.hex||'#888'};border:1px solid #555;border-radius:2px;vertical-align:middle;margin:0 2px"></span>${c}`;
  }).join(' → ');
}

function buildSMDUI(container) {
  container.innerHTML = `
    <div class="psection" style="border-top:1px solid #0f3460;padding-top:10px">
      <h3>SMD Code Decoder</h3>
      <div style="margin-bottom:4px;font-size:10px;color:#555">3/4-digit, EIA-96, R-notation, capacitor codes</div>
      <input id="smd-code" placeholder="e.g. 103, 4R7, 01A, 104, 2p2" style="background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:4px;padding:6px 10px;font-size:13px;width:100%">
      <div id="smd-result" style="margin-top:6px;font-size:12px;color:#e0e0e0;min-height:40px"></div>
    </div>
  `;
  container.querySelector('#smd-code').addEventListener('input', e => updateSMDResult(container, e.target.value));
}

function updateSMDResult(container, code) {
  const resultEl = container.querySelector('#smd-result');
  const results = decodeSMD(code);
  if (!results.length) {
    resultEl.innerHTML = code ? '<span style="color:#666">No match</span>' : '';
    return;
  }
  resultEl.innerHTML = results.map(r =>
    `<div style="margin-bottom:4px"><span style="color:#888;font-size:10px">${r.type}:</span> <strong style="color:#4488ff">${r.value}</strong></div>`
  ).join('');
}

// ─── Formatting helpers ────────────────────────────────────────────────────────
function fmtR(ohms) {
  if (ohms >= 1e6) return (ohms / 1e6).toFixed(ohms % 1e6 ? 2 : 0) + ' MΩ';
  if (ohms >= 1e3) return (ohms / 1e3).toFixed(ohms % 1e3 ? 2 : 0) + ' kΩ';
  return ohms.toFixed(ohms < 1 ? 2 : ohms < 10 ? 1 : 0) + ' Ω';
}

function fmtC(pf) {
  if (pf >= 1e6) return (pf / 1e6).toFixed(pf % 1e6 ? 1 : 0) + ' µF';
  if (pf >= 1e3) return (pf / 1e3).toFixed(pf % 1e3 ? 1 : 0) + ' nF';
  return pf.toFixed(pf < 1 ? 2 : 0) + ' pF';
}
