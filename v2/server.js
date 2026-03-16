const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8092;
const PROJECTS_DIR = path.join(__dirname, 'projects');

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer storage — store images in projects/<name>/
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(PROJECTS_DIR, req.params.name);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const side = req.params.side; // 'top' or 'bottom'
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${side}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/projects — list all projects
app.get('/api/projects', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return res.json([]);
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonPath = path.join(PROJECTS_DIR, entry.name, 'project.json');
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const stat = fs.statSync(jsonPath);
        projects.push({
          name: entry.name,
          boardName: data.boardName || entry.name,
          boardWidth: data.boardWidth || 0,
          boardHeight: data.boardHeight || 0,
          components: (data.components || []).length,
          markers: (data.markers || []).length,
          savedAt: stat.mtimeMs,
          hasTopImage: fs.existsSync(path.join(PROJECTS_DIR, entry.name, 'top.jpg')) ||
                       fs.existsSync(path.join(PROJECTS_DIR, entry.name, 'top.png')) ||
                       fs.existsSync(path.join(PROJECTS_DIR, entry.name, 'top.webp')),
          hasBottomImage: fs.existsSync(path.join(PROJECTS_DIR, entry.name, 'bottom.jpg')) ||
                          fs.existsSync(path.join(PROJECTS_DIR, entry.name, 'bottom.png')) ||
                          fs.existsSync(path.join(PROJECTS_DIR, entry.name, 'bottom.webp')),
        });
      } catch (e) {
        // skip malformed
      }
    }
    projects.sort((a, b) => b.savedAt - a.savedAt);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:name — save project JSON
app.post('/api/projects/:name', (req, res) => {
  try {
    const dir = path.join(PROJECTS_DIR, req.params.name);
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, 'project.json');
    fs.writeFileSync(jsonPath, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true, name: req.params.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:name — load project JSON
app.get('/api/projects/:name', (req, res) => {
  try {
    const jsonPath = path.join(PROJECTS_DIR, req.params.name, 'project.json');
    if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Project not found' });
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:name — delete project
app.delete('/api/projects/:name', (req, res) => {
  try {
    const dir = path.join(PROJECTS_DIR, req.params.name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Project not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:name/images/:side — upload board image
app.post('/api/projects/:name/images/:side', upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const side = req.params.side;
    const ext = path.extname(req.file.filename);
    // Remove old images for this side (different extension)
    const dir = path.join(PROJECTS_DIR, req.params.name);
    for (const ext2 of ['.jpg', '.jpeg', '.png', '.webp']) {
      const old = path.join(dir, `${side}${ext2}`);
      if (old !== req.file.path && fs.existsSync(old)) fs.unlinkSync(old);
    }
    const url = `/api/projects/${req.params.name}/images/${side}`;
    res.json({ ok: true, url, filename: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:name/images/:side — serve board image
app.get('/api/projects/:name/images/:side', (req, res) => {
  const dir = path.join(PROJECTS_DIR, req.params.name);
  const side = req.params.side;
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const imgPath = path.join(dir, `${side}${ext}`);
    if (fs.existsSync(imgPath)) {
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
      res.setHeader('Content-Type', mimeMap[ext] || 'image/jpeg');
      return res.sendFile(imgPath);
    }
  }
  res.status(404).json({ error: 'Image not found' });
});

app.listen(PORT, () => {
  console.log(`PCB Mapper v2 running at http://localhost:${PORT}`);
});
