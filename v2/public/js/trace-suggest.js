/**
 * PCB Mapper v2 — Trace Suggestion Engine
 * Analyzes board photos to detect copper traces and suggest routing paths.
 * 
 * How it works:
 * 1. Sample the board image at each marker/pad location
 * 2. Build a copper-probability heatmap from the image
 * 3. Use flood-fill from each marker to find connected copper regions
 * 4. Suggest traces between markers that share connected copper
 * 5. User can accept/reject each suggestion
 *
 * Copper detection uses HSV color analysis:
 *  - Copper appears as warm tones (orange/brown/gold) on bare boards
 *  - Green solder mask covers non-trace areas
 *  - We detect copper vs mask using hue/saturation thresholds
 */

// ─── Color Analysis ───────────────────────────────────────────────────────────

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0, s = max === 0 ? 0 : d / max, v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, v };
}

/**
 * Score how likely a pixel is to be a conductive feature (0-1).
 * Handles multiple board appearances:
 *  - Bare copper: warm orange/brown/gold (hue 10-55)
 *  - Solder/tin: bright silver-gray (low saturation, high value)
 *  - Solder mask: green (hue 80-160) — NEGATIVE indicator
 *  - Dark substrate/holes: very dark — partially conductive
 *  - Reflective pads: very bright, low saturation
 *  - Oxidized copper: reddish-brown
 *  - Lead-free solder: matte gray
 */
function copperScore(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  
  // Very very dark = hole or shadow (could be a via!)
  if (v < 0.08) return 0.2;
  
  // Green solder mask — NOT copper (strong negative)
  if (h >= 80 && h <= 160 && s > 0.2 && v > 0.15) return 0;
  
  // === Positive indicators ===
  
  // Classic copper: warm orange/brown/gold, hue 10-55
  if (h >= 10 && h <= 55 && s > 0.15 && v > 0.2) {
    return Math.min(1, (s * 0.5 + v * 0.5) * 1.3);
  }
  
  // Bright reflective metal (solder, tin, pad flash)
  // Low saturation + high value = shiny metal
  if (s < 0.2 && v > 0.6) {
    return 0.5 + v * 0.3; // Brighter = more confident
  }
  
  // Medium-bright gray (lead-free solder, matte tin)
  if (s < 0.15 && v > 0.35 && v < 0.7) {
    return 0.35;
  }
  
  // Oxidized/tarnished copper (reddish, brownish)
  if (h >= 0 && h <= 25 && s > 0.2 && v > 0.15) {
    return 0.4 + s * 0.3;
  }
  
  // Yellow/gold (ENIG finish, gold plating)
  if (h >= 40 && h <= 65 && s > 0.25 && v > 0.35) {
    return 0.65;
  }
  
  // Blue-ish (some soldermask colors) — weak negative
  if (h >= 200 && h <= 260 && s > 0.2) return 0.05;
  
  // Dark with slight warmth (trace under thin mask)
  if (v < 0.3 && v > 0.08 && s < 0.3) {
    // Could be a trace showing through dark mask
    return 0.15;
  }
  
  return 0.1; // Small baseline for everything else
}

// ─── Image Sampling ───────────────────────────────────────────────────────────

/**
 * Extract a copper probability map from the board image.
 * Returns a 2D array of copper scores (0-1) at reduced resolution.
 */
function buildCopperMap(imageData, width, height, step = 4) {
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const map = new Float32Array(cols * rows);
  
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = Math.min(x * step, width - 1);
      const py = Math.min(y * step, height - 1);
      const idx = (py * width + px) * 4;
      const r = imageData[idx], g = imageData[idx + 1], b = imageData[idx + 2];
      map[y * cols + x] = copperScore(r, g, b);
    }
  }
  
  // Smooth the map (3x3 box filter) to reduce noise
  const smoothed = new Float32Array(cols * rows);
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += map[(y + dy) * cols + (x + dx)];
        }
      }
      smoothed[y * cols + x] = sum / 9;
    }
  }
  
  return { map: smoothed, cols, rows, step };
}

// ─── Flood Fill Path Finding ──────────────────────────────────────────────────

/**
 * From a starting point, flood-fill through copper regions.
 * Returns a set of all reachable copper cells.
 */
function floodFillCopper(copperMap, startX, startY, threshold = 0.3) {
  const { map, cols, rows, step } = copperMap;
  const sx = Math.floor(startX / step);
  const sy = Math.floor(startY / step);
  
  if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return new Set();
  
  const visited = new Set();
  const queue = [[sx, sy]];
  const key = (x, y) => y * cols + x;
  
  // Even if start isn't on copper, include it (it's a pad/marker location)
  visited.add(key(sx, sy));
  
  while (queue.length > 0) {
    const [cx, cy] = queue.shift();
    
    // 8-connected neighbors
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        if (map[k] >= threshold) {
          visited.add(k);
          queue.push([nx, ny]);
        }
      }
    }
    
    // Limit flood fill to prevent runaway on large images
    if (visited.size > 50000) break;
  }
  
  return visited;
}

/**
 * Find the shortest copper path between two points using A*.
 * Returns array of {x, y} points in image coordinates, or null if no path.
 */
function findCopperPath(copperMap, fromX, fromY, toX, toY, threshold = 0.2) {
  const { map, cols, rows, step } = copperMap;
  const sx = Math.clamp(Math.floor(fromX / step), 0, cols - 1);
  const sy = Math.clamp(Math.floor(fromY / step), 0, rows - 1);
  const ex = Math.clamp(Math.floor(toX / step), 0, cols - 1);
  const ey = Math.clamp(Math.floor(toY / step), 0, rows - 1);
  
  const key = (x, y) => y * cols + x;
  const heuristic = (x, y) => Math.abs(x - ex) + Math.abs(y - ey);
  
  // Priority queue (simple sorted array — fine for our grid sizes)
  const open = [{ x: sx, y: sy, g: 0, f: heuristic(sx, sy), parent: null }];
  const closed = new Map();
  
  let iterations = 0;
  const maxIter = 100000;
  
  while (open.length > 0 && iterations++ < maxIter) {
    // Find lowest f-score
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0];
    const ck = key(current.x, current.y);
    
    if (current.x === ex && current.y === ey) {
      // Reconstruct path
      const path = [];
      let node = current;
      while (node) {
        path.unshift({ x: node.x * step, y: node.y * step });
        node = node.parent;
      }
      return simplifyPath(path, step * 2);
    }
    
    if (closed.has(ck)) continue;
    closed.set(ck, true);
    
    // 8-connected neighbors
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = current.x + dx, ny = current.y + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const nk = key(nx, ny);
        if (closed.has(nk)) continue;
        
        const score = map[nk];
        // Cost: lower copper score = higher cost (penalize non-copper paths)
        const moveCost = (dx !== 0 && dy !== 0) ? 1.414 : 1;
        const copperPenalty = score >= threshold ? (1 - score) * 0.5 : 5; // Heavy penalty for leaving copper
        const g = current.g + moveCost + copperPenalty;
        
        open.push({ x: nx, y: ny, g, f: g + heuristic(nx, ny), parent: current });
      }
    }
  }
  
  return null; // No path found
}

// Polyfill Math.clamp
Math.clamp = Math.clamp || ((v, min, max) => Math.min(Math.max(v, min), max));

/**
 * Simplify a path by removing collinear points (Ramer-Douglas-Peucker).
 */
function simplifyPath(points, epsilon = 4) {
  if (points.length <= 2) return points;
  
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  
  if (maxDist > epsilon) {
    const left = simplifyPath(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyPath(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  
  return [first, last];
}

function pointToLineDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ─── Suggestion Engine ────────────────────────────────────────────────────────

let suggestions = [];
let copperMapCache = null;
let heatmapCanvas = null;

/**
 * Analyze a board image and generate trace suggestions between markers.
 * @param {HTMLImageElement|HTMLCanvasElement} imageEl - The board image
 * @param {Array} markers - Array of {id, label, x, y} marker positions
 * @param {Object} options - {threshold, maxSuggestions, step}
 * @returns {Array} suggestions - Array of {from, to, path, confidence}
 */
export function analyzeBoard(imageEl, markers, options = {}) {
  const imgW = imageEl.naturalWidth || imageEl.width;
  const imgH = imageEl.naturalHeight || imageEl.height;
  // Auto-scale step for large images (target ~500x500 grid max)
  const autoStep = Math.max(3, Math.ceil(Math.max(imgW, imgH) / 500));
  const { threshold = 0.2, maxSuggestions = 50, step = autoStep } = options;
  suggestions = [];
  
  if (!imageEl || !markers.length) return suggestions;
  
  // Draw image to temp canvas to get pixel data
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = imageEl.naturalWidth || imageEl.width;
  tempCanvas.height = imageEl.naturalHeight || imageEl.height;
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(imageEl, 0, 0);
  
  const imgData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  
  // Build copper map
  copperMapCache = buildCopperMap(imgData.data, tempCanvas.width, tempCanvas.height, step);
  
  // Strategy: flood-fill from each marker to find connected copper regions,
  // then check which other markers fall within the same connected region.
  // This is O(markers × grid) instead of O(markers² × pathfinding).
  
  const { map, cols, rows } = copperMapCache;
  const markerGridPos = markers.map(m => ({
    ...m,
    gx: Math.min(Math.floor(m.x / step), cols - 1),
    gy: Math.min(Math.floor(m.y / step), rows - 1),
  }));
  
  const key = (x, y) => y * cols + x;
  const alreadySuggested = new Set();
  
  for (let i = 0; i < markerGridPos.length && suggestions.length < maxSuggestions; i++) {
    const src = markerGridPos[i];
    
    // Flood fill from this marker through copper-scored cells
    const visited = floodFillCopper(copperMapCache, src.x, src.y, threshold);
    
    if (visited.size < 5) continue; // Too small to be meaningful
    
    // Check which other markers are reachable
    for (let j = i + 1; j < markerGridPos.length && suggestions.length < maxSuggestions; j++) {
      const dst = markerGridPos[j];
      const dstKey = key(dst.gx, dst.gy);
      
      // Check if destination is in the flood-fill region (or very close to it)
      let reachable = visited.has(dstKey);
      if (!reachable) {
        // Check immediate neighbors too (tolerance for marker placement imprecision)
        for (let dy = -2; dy <= 2 && !reachable; dy++) {
          for (let dx = -2; dx <= 2 && !reachable; dx++) {
            const nx = dst.gx + dx, ny = dst.gy + dy;
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && visited.has(key(nx, ny))) {
              reachable = true;
            }
          }
        }
      }
      
      if (!reachable) continue;
      
      // Avoid duplicate suggestions
      const pairKey = [src.id, dst.id].sort().join('|');
      if (alreadySuggested.has(pairKey)) continue;
      alreadySuggested.add(pairKey);
      
      // Calculate confidence from copper scores at both endpoints and the path density
      const scoreA = sampleCopperAt(copperMapCache, src.x, src.y);
      const scoreB = sampleCopperAt(copperMapCache, dst.x, dst.y);
      const regionDensity = Math.min(1, visited.size / 500); // Larger regions = higher confidence
      const confidence = (scoreA + scoreB) / 2 * 0.6 + regionDensity * 0.4;
      
      // Create a simple straight-line path (the flood fill proves connectivity)
      const path = [
        { x: src.x, y: src.y },
        { x: dst.x, y: dst.y },
      ];
      
      // Try A* for a better visual path if markers are close enough
      const dist = Math.hypot(src.gx - dst.gx, src.gy - dst.gy);
      if (dist < 200) {
        const detailedPath = findCopperPath(copperMapCache, src.x, src.y, dst.x, dst.y, threshold * 0.8);
        if (detailedPath && detailedPath.length >= 2) {
          path.length = 0;
          path.push(...detailedPath);
        }
      }
      
      suggestions.push({
        id: `sug_${i}_${j}`,
        from: src,
        to: dst,
        path,
        confidence: Math.min(1, confidence),
        accepted: false,
        rejected: false,
      });
    }
  }
  
  // Sort by confidence (highest first)
  suggestions.sort((a, b) => b.confidence - a.confidence);
  
  return suggestions;
}

function sampleCopperAt(copperMap, x, y) {
  const { map, cols, rows, step } = copperMap;
  const mx = Math.floor(x / step);
  const my = Math.floor(y / step);
  if (mx < 0 || mx >= cols || my < 0 || my >= rows) return 0;
  return map[my * cols + mx];
}

/**
 * Generate a copper heatmap overlay for visualization.
 * Returns a canvas element that can be overlaid on the board image.
 */
export function generateHeatmap(width, height) {
  if (!copperMapCache) return null;
  
  if (!heatmapCanvas) {
    heatmapCanvas = document.createElement('canvas');
  }
  heatmapCanvas.width = width;
  heatmapCanvas.height = height;
  const ctx = heatmapCanvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  
  const { map, cols, rows, step } = copperMapCache;
  const scaleX = width / (cols * step);
  const scaleY = height / (rows * step);
  
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const score = map[y * cols + x];
      if (score < 0.15) continue;
      
      // Copper = orange/gold, higher score = more opaque
      const alpha = Math.min(0.6, score * 0.7);
      const r = Math.round(200 + score * 55);
      const g = Math.round(120 + score * 80);
      const b = Math.round(20 + score * 30);
      
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(x * step * scaleX, y * step * scaleY, step * scaleX + 1, step * scaleY + 1);
    }
  }
  
  return heatmapCanvas;
}

/**
 * Get current suggestions
 */
export function getSuggestions() { return suggestions; }

/**
 * Accept a suggestion (mark it for trace creation)
 */
export function acceptSuggestion(sugId) {
  const sug = suggestions.find(s => s.id === sugId);
  if (sug) { sug.accepted = true; sug.rejected = false; }
  return sug;
}

/**
 * Reject a suggestion
 */
export function rejectSuggestion(sugId) {
  const sug = suggestions.find(s => s.id === sugId);
  if (sug) { sug.rejected = true; sug.accepted = false; }
  return sug;
}

/**
 * Clear all suggestions
 */
export function clearSuggestions() {
  suggestions = [];
  copperMapCache = null;
}
