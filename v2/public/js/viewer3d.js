/**
 * PCB Mapper v2 — 3D Viewer
 * Three.js r128 based 3D PCB visualizer.
 * Port from v1 PCBMapper.open3D()
 */

let renderer3d = null;
let running3d = false;
let orb = null;
let updateCam3d = null;
let resize3d = null;

export function open3DViewer(board) {
  if (!board) return;
  if (typeof THREE === 'undefined') { alert('Three.js not loaded'); return; }

  const viewerEl = document.getElementById('viewer3d');
  if (!viewerEl) return;

  // Cleanup old renderer
  if (renderer3d) {
    running3d = false;
    if (renderer3d.domElement.parentNode === viewerEl) viewerEl.removeChild(renderer3d.domElement);
    renderer3d.dispose();
    renderer3d = null;
  }
  const existingCompass = viewerEl.querySelector('.compass-div');
  if (existingCompass) existingCompass.remove();

  viewerEl.style.display = 'block';

  const W = window.innerWidth, H = window.innerHeight;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 10000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(window.devicePixelRatio);
  viewerEl.insertBefore(renderer.domElement, viewerEl.firstChild);
  renderer3d = renderer;

  // Lighting — three-point setup for PBR feel
  scene.add(new THREE.AmbientLight(0x404060, 0.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(200, 500, 300);
  keyLight.castShadow = false;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8899cc, 0.4);
  fillLight.position.set(-200, 200, -100);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
  rimLight.position.set(0, -300, 200);
  scene.add(rimLight);
  // Hemisphere light for ambient sky/ground
  scene.add(new THREE.HemisphereLight(0x8888cc, 0x444422, 0.3));

  // Compute board bounds
  const outline = board.outline;
  let bx1, by1, bx2, by2;
  if (outline?.length >= 3) {
    bx1 = Math.min(...outline.map(p => p.x)); by1 = Math.min(...outline.map(p => p.y));
    bx2 = Math.max(...outline.map(p => p.x)); by2 = Math.max(...outline.map(p => p.y));
  } else {
    const allPts = board.markers.filter(m => m.t !== 'align').map(m => ({ x: m.x, y: m.y }));
    board.components.forEach(c => { if (c.bounds) { allPts.push({ x: c.bounds.x1, y: c.bounds.y1 }, { x: c.bounds.x2, y: c.bounds.y2 }); } });
    if (!allPts.length) { bx1 = 0; by1 = 0; bx2 = 500; by2 = 300; }
    else { bx1 = Math.min(...allPts.map(p => p.x)) - 20; by1 = Math.min(...allPts.map(p => p.y)) - 20; bx2 = Math.max(...allPts.map(p => p.x)) + 20; by2 = Math.max(...allPts.map(p => p.y)) + 20; }
  }
  const bw = bx2 - bx1, bh = by2 - by1;
  const cx = (bx1 + bx2) / 2, cy = (by1 + by2) / 2;
  const boardThickness = Math.max(bw, bh) * 0.015;
  const copperThick = boardThickness * 0.05;
  const compHeight = boardThickness * 0.3;

  // Board substrate
  let boardShape = new THREE.Shape();
  if (outline?.length >= 3) {
    boardShape.moveTo(outline[0].x - cx, outline[0].y - cy);
    outline.slice(1).forEach(p => boardShape.lineTo(p.x - cx, p.y - cy));
  } else {
    boardShape.moveTo(-bw / 2, -bh / 2); boardShape.lineTo(bw / 2, -bh / 2);
    boardShape.lineTo(bw / 2, bh / 2); boardShape.lineTo(-bw / 2, bh / 2);
  }
  boardShape.closePath();
  const boardGeo = new THREE.ExtrudeGeometry(boardShape, { depth: boardThickness, bevelEnabled: false });
  // Solder mask material (semi-glossy green)
  const maskMat = new THREE.MeshStandardMaterial({ color: 0x0a5c0a, roughness: 0.4, metalness: 0.0 });
  const boardMesh = new THREE.Mesh(boardGeo, maskMat);
  boardMesh.rotation.x = -Math.PI / 2;
  boardMesh.position.y = -boardThickness / 2;
  scene.add(boardMesh);

  // PBR materials
  const copperMat = new THREE.MeshStandardMaterial({ color: 0xd4944a, roughness: 0.3, metalness: 0.85 });
  const copperBotMat = new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.35, metalness: 0.8 });
  const holeMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.2, metalness: 0.9 }); // HASL solder
  const icMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7, metalness: 0.0 });

  // Traces
  (board.traces || []).forEach(t => {
    if (!t.points?.length) return;
    const w = (t.width || 3) * 0.8;
    const isBot = t.layer === 'bottom';
    const yPos = isBot ? -(boardThickness / 2 + copperThick / 2) : (boardThickness / 2 + copperThick / 2);
    const mat = isBot ? copperBotMat : copperMat;
    for (let i = 0; i < t.points.length - 1; i++) {
      const p1 = t.points[i], p2 = t.points[i + 1];
      const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
      if (len < 0.1) continue;
      const geo = new THREE.BoxGeometry(len + w, copperThick, w);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((p1.x + p2.x) / 2 - cx, yPos, -((p1.y + p2.y) / 2 - cy));
      mesh.rotation.y = Math.atan2(dy, dx);
      scene.add(mesh);
    }
  });

  // Pours
  (board.pours || []).forEach(p => {
    if (!p.points?.length) return;
    const isBot = p.layer === 'bottom';
    const shape = new THREE.Shape();
    shape.moveTo(p.points[0].x - cx, p.points[0].y - cy);
    p.points.slice(1).forEach(pt => shape.lineTo(pt.x - cx, pt.y - cy));
    shape.closePath();
    (p.cutouts || []).forEach(c => {
      const hole = new THREE.Path();
      hole.moveTo(c.points[0].x - cx, c.points[0].y - cy);
      c.points.slice(1).forEach(pt => hole.lineTo(pt.x - cx, pt.y - cy));
      hole.closePath();
      shape.holes.push(hole);
    });
    const geo = new THREE.ExtrudeGeometry(shape, { depth: copperThick, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, isBot ? copperBotMat : copperMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = isBot ? -(boardThickness / 2 + copperThick) : boardThickness / 2;
    scene.add(mesh);
  });

  // Markers (vias/holes)
  board.markers.filter(m => m.t === 'marker').forEach(m => {
    const r = (m.holeSize || (m.markerType === 'hole' ? 8 : 4)) * 0.6;
    const geo = new THREE.CylinderGeometry(r, r, boardThickness * 1.3, 12);
    const holeMesh = new THREE.Mesh(geo, holeMat);
    holeMesh.position.set(m.x - cx, 0, -(m.y - cy));
    scene.add(holeMesh);
    const rg = new THREE.CylinderGeometry(r * 1.5, r * 1.5, copperThick, 12);
    const ringMesh = new THREE.Mesh(rg, copperMat);
    ringMesh.position.set(m.x - cx, boardThickness / 2 + copperThick / 2, -(m.y - cy));
    scene.add(ringMesh);
  });

  // Pins
  board.markers.filter(m => m.t === 'pin').forEach(m => {
    const geo = new THREE.CylinderGeometry(2, 2, boardThickness * 1.8, 8);
    const pinMesh = new THREE.Mesh(geo, holeMat);
    pinMesh.position.set(m.x - cx, 0, -(m.y - cy));
    scene.add(pinMesh);
    const padGeo = new THREE.CylinderGeometry(4, 4, copperThick, 8);
    const padMesh = new THREE.Mesh(padGeo, copperMat);
    padMesh.position.set(m.x - cx, boardThickness / 2 + copperThick / 2, -(m.y - cy));
    scene.add(padMesh);
  });

  // SMD pads
  board.markers.filter(m => m.t === 'smd').forEach(m => {
    const geo = new THREE.BoxGeometry((m.padWidth || 14) * 0.8, copperThick, (m.padHeight || 8) * 0.8);
    const isBot = m.layer === 'bottom';
    const mesh = new THREE.Mesh(geo, copperMat);
    mesh.position.set(m.x - cx, isBot ? -(boardThickness / 2 + copperThick / 2) : (boardThickness / 2 + copperThick / 2), -(m.y - cy));
    scene.add(mesh);
  });

  // Silkscreen material
  const silkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  // Lead material
  const leadMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.7 });

  // Components
  board.components.forEach(c => {
    if (!c.bounds) return;
    const b = c.bounds;
    const w = b.x2 - b.x1, h = b.y2 - b.y1;
    const mx = (b.x1 + b.x2) / 2 - cx, my = (b.y1 + b.y2) / 2 - cy;
    const isBot = c.layer === 'bottom';
    const sign = isBot ? -1 : 1;

    if (c.compType === 'ic') {
      // IC: black epoxy body with pin-1 marker
      const bodyH = compHeight * 2.5;
      const bodyGeo = new THREE.BoxGeometry(w * 0.85, bodyH, h * 0.85);
      const bodyMesh = new THREE.Mesh(bodyGeo, icMat);
      bodyMesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
      scene.add(bodyMesh);

      // Pin-1 dot
      const dotGeo = new THREE.SphereGeometry(Math.min(w, h) * 0.05, 8, 8);
      const dotMesh = new THREE.Mesh(dotGeo, silkMat);
      dotMesh.position.set(mx - w * 0.3, sign * (boardThickness / 2 + bodyH + 0.5), -(my - h * 0.3));
      scene.add(dotMesh);

      // IC leads (gull-wing style) — along the long sides
      const pins = c.pinCount || 8;
      const pinsPerSide = Math.ceil(pins / 2);
      const leadW = Math.min(w * 0.06, 3);
      const leadH = compHeight * 0.5;
      for (let i = 0; i < pinsPerSide; i++) {
        const frac = (i + 0.5) / pinsPerSide;
        const lx = b.x1 + frac * w - cx;
        // Top side leads
        const lead1 = new THREE.Mesh(new THREE.BoxGeometry(leadW, leadH, h * 0.1), leadMat);
        lead1.position.set(lx, sign * (boardThickness / 2 + leadH / 2), -(my - h * 0.48));
        scene.add(lead1);
        // Bottom side leads
        if (i < pins - pinsPerSide) {
          const lead2 = new THREE.Mesh(new THREE.BoxGeometry(leadW, leadH, h * 0.1), leadMat);
          lead2.position.set(lx, sign * (boardThickness / 2 + leadH / 2), -(my + h * 0.48));
          scene.add(lead2);
        }
      }
    } else if (c.compType === 'cap') {
      // Capacitor: cylindrical electrolytic or box ceramic
      const bodyH = compHeight * 3;
      if (w > h * 1.5 || h > w * 1.5) {
        // Box ceramic cap
        const geo = new THREE.BoxGeometry(w, bodyH, h);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.5, metalness: 0.1 }));
        mesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
        scene.add(mesh);
      } else {
        // Cylindrical electrolytic
        const r = Math.min(w, h) * 0.45;
        const geo = new THREE.CylinderGeometry(r, r, bodyH, 16);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x222266, roughness: 0.4, metalness: 0.1 }));
        mesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
        scene.add(mesh);
        // Vent cross on top
        const ventGeo = new THREE.CylinderGeometry(r * 0.85, r * 0.85, 0.5, 16);
        const ventMesh = new THREE.Mesh(ventGeo, new THREE.MeshStandardMaterial({ color: 0x333388, roughness: 0.6 }));
        ventMesh.position.set(mx, sign * (boardThickness / 2 + bodyH + 0.25), -my);
        scene.add(ventMesh);
      }
    } else if (c.compType === 'res') {
      // Resistor: small rounded body
      const bodyH = compHeight * 1.2;
      const geo = new THREE.BoxGeometry(w, bodyH, h);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2a4a2a, roughness: 0.5 }));
      mesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
      scene.add(mesh);
    } else if (c.compType === 'diode') {
      // Diode: glass body with cathode band
      const bodyH = compHeight * 1.5;
      const geo = new THREE.BoxGeometry(w, bodyH, h);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3, metalness: 0.2 }));
      mesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
      scene.add(mesh);
      // Cathode band
      const bandGeo = new THREE.BoxGeometry(w * 0.15, bodyH * 1.02, h * 1.02);
      const bandMesh = new THREE.Mesh(bandGeo, silkMat);
      bandMesh.position.set(mx - w * 0.35, sign * (boardThickness / 2 + bodyH / 2), -my);
      scene.add(bandMesh);
    } else if (c.compType === 'connector') {
      // Connector: tall rectangular housing
      const bodyH = compHeight * 5;
      const geo = new THREE.BoxGeometry(w, bodyH, h);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xf5f5dc, roughness: 0.7, metalness: 0.0 }));
      mesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
      scene.add(mesh);
    } else {
      // Generic: simple box
      const bodyH = compHeight * 1.5;
      const geo = new THREE.BoxGeometry(w, bodyH, h);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.6 }));
      mesh.position.set(mx, sign * (boardThickness / 2 + bodyH / 2), -my);
      scene.add(mesh);
    }

    // Silkscreen label (canvas texture)
    try {
      const labelCanvas = document.createElement('canvas');
      const fontSize = Math.min(64, Math.max(16, Math.min(w, h) * 0.5));
      labelCanvas.width = 256;
      labelCanvas.height = 64;
      const ctx2d = labelCanvas.getContext('2d');
      ctx2d.fillStyle = 'transparent';
      ctx2d.clearRect(0, 0, 256, 64);
      ctx2d.fillStyle = '#ffffff';
      ctx2d.font = `bold ${fontSize}px monospace`;
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText(c.label, 128, 32);

      const texture = new THREE.CanvasTexture(labelCanvas);
      texture.minFilter = THREE.LinearFilter;
      const labelGeo = new THREE.PlaneGeometry(w * 0.8, h * 0.3);
      const labelMat2 = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
      const labelMesh = new THREE.Mesh(labelGeo, labelMat2);
      const bodyTop = c.compType === 'ic' ? compHeight * 2.5 : c.compType === 'cap' ? compHeight * 3 : compHeight * 1.5;
      labelMesh.position.set(mx, sign * (boardThickness / 2 + bodyTop + 1), -my);
      labelMesh.rotation.x = -Math.PI / 2;
      if (isBot) labelMesh.rotation.x = Math.PI / 2;
      scene.add(labelMesh);
    } catch { /* label rendering optional */ }
  });

  // Ground grid
  const maxDim = Math.max(bw, bh);
  const gridHelper = new THREE.GridHelper(maxDim * 2, 20, 0x333355, 0x222244);
  gridHelper.position.y = -(boardThickness / 2 + boardThickness * 0.5);
  scene.add(gridHelper);

  // Camera & orbit
  orb = { theta: Math.PI * 0.3, phi: Math.PI * 0.25, dist: maxDim * 1.0, panX: 0, panZ: 0 };

  updateCam3d = () => {
    camera.position.set(
      orb.panX + orb.dist * Math.sin(orb.theta) * Math.cos(orb.phi),
      orb.dist * Math.sin(orb.phi),
      orb.panZ + orb.dist * Math.cos(orb.theta) * Math.cos(orb.phi)
    );
    camera.lookAt(orb.panX, 0, orb.panZ);
  };
  updateCam3d();

  let isDragging = false, isRightDrag = false, lastX = 0, lastY = 0;
  renderer.domElement.addEventListener('mousedown', e => { isDragging = true; isRightDrag = e.button !== 0 || e.shiftKey; lastX = e.clientX; lastY = e.clientY; e.preventDefault(); });
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
  renderer.domElement.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (isRightDrag) {
      const panSpeed = orb.dist * 0.001;
      const camRight = new THREE.Vector3(); camRight.setFromMatrixColumn(camera.matrixWorld, 0);
      const camUp = new THREE.Vector3(); camUp.setFromMatrixColumn(camera.matrixWorld, 1);
      orb.panX -= dx * camRight.x * panSpeed - dy * camUp.x * panSpeed;
      orb.panZ -= dx * camRight.z * panSpeed - dy * camUp.z * panSpeed;
    } else {
      orb.theta -= dx * 0.005;
      orb.phi = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, orb.phi + dy * 0.005));
    }
    lastX = e.clientX; lastY = e.clientY;
    updateCam3d();
  });
  renderer.domElement.addEventListener('mouseup', () => { isDragging = false; });
  renderer.domElement.addEventListener('wheel', e => {
    e.preventDefault();
    orb.dist *= e.deltaY > 0 ? 1.1 : 0.9;
    orb.dist = Math.max(maxDim * 0.1, Math.min(maxDim * 5, orb.dist));
    updateCam3d();
  });

  running3d = true;
  const animate = () => {
    if (!running3d) return;
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };
  animate();

  resize3d = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize3d);
}

export function close3DViewer() {
  running3d = false;
  const viewerEl = document.getElementById('viewer3d');
  if (viewerEl) viewerEl.style.display = 'none';
  if (resize3d) { window.removeEventListener('resize', resize3d); resize3d = null; }
  if (renderer3d) {
    if (renderer3d.domElement.parentNode) renderer3d.domElement.parentNode.removeChild(renderer3d.domElement);
    renderer3d.dispose();
    renderer3d = null;
  }
  orb = null; updateCam3d = null;
}

export function set3DView(view) {
  if (!orb || !updateCam3d) return;
  switch (view) {
    case 'top':    orb.theta = 0; orb.phi = Math.PI * 0.44; break;
    case 'bottom': orb.theta = 0; orb.phi = -Math.PI * 0.44; break;
    case 'front':  orb.theta = 0; orb.phi = 0; break;
    case 'iso':    orb.theta = Math.PI * 0.3; orb.phi = Math.PI * 0.25; break;
  }
  updateCam3d();
}

// Expose for non-module HTML onclick handlers
window.close3D = close3DViewer;
window.set3DView = set3DView;
