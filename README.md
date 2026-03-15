# PCB Mapper

A web-based PCB reverse engineering tool. Single HTML file, no build tools, no server required.

Built for tracing and documenting physical PCB boards from photographs — place markers, draw traces, map components, and export to industry-standard Gerber files.

## Features

- **Board image import** — Load top/bottom photos, align with affine transform
- **Component mapping** — IC outlines with manual pin placement, capacitors, resistors, diodes, transistors
- **Trace drawing** — Freeform copper traces with adjustable width
- **Copper pours** — Polygon fills with SVG punchout cutouts
- **Net connections** — Link pins/markers to document connectivity
- **Layer system** — Top/bottom layer visibility with through-hole items on both sides
- **Gerber RS-274X export** — Industry-standard output: copper, soldermask, silkscreen, outline, Excellon drill
- **3D PCB viewer** — Three.js-powered board visualization with orbit controls
- **Component test data** — Record multimeter readings (capacitor, resistor, diode, MOSFET, BJT, inductor, zener)
- **Resistor calculator** — Color band decoder (4/5-band) with reverse lookup
- **Project save/load** — Zip-based .pcbm files bundle project data + board images
- **Alignment engine** — Full affine least-squares transform with auto mirror detection for flipped boards

## Quick Start

1. Open `index.html` in a browser (or serve it: `python3 -m http.server 8091`)
2. Load board photos (top/bottom) via the file buttons in the topbar
3. Place alignment points on both sides, click "Apply" to register
4. Start mapping: place components, draw traces, create pours
5. Export: Save as `.pcbm` project or export Gerber files

## Stack

- [Fabric.js](http://fabricjs.com/) 5.3.1 — Canvas rendering & interaction
- [JSZip](https://stuk.github.io/jszip/) 3.10.1 — Project file bundling
- [Three.js](https://threejs.org/) r128 — 3D visualization

All loaded via CDN. Zero dependencies to install.

## Gerber Export

Exports a zip containing:
- `copper_top.gtl` — Top copper layer (traces, pads, pours)
- `soldermask_top.gts` — Top soldermask openings
- `silkscreen_top.gto` — Top silkscreen (component outlines)
- `board_outline.gko` — Board edge profile
- `drill.xln` — Excellon drill file

Compatible with JLCPCB, PCBWay, OSHPark, KiCad, Eagle, Altium, and [tracespace.io](https://tracespace.io/view).

## Keyboard Shortcuts

| Key | Tool |
|-----|------|
| V | Select |
| H | Pan |
| M | Marker |
| C | Component |
| D | SMD Pad |
| N | Net |
| T | Trace |
| P | Pour |
| U | Punchout |
| O | Board Outline |
| A | Alignment |
| Enter | Finish drawing |
| Delete | Delete selected |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |

## License

MIT
