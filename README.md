# Kiln

**A 3D modelling application that runs in a browser tab.** Kiln is an open source
alternative to Blender's modelling workflow — mesh editing, a non-destructive
modifier stack, PBR materials and glTF export — in a static bundle with no
runtime dependencies, no account and no server. Your scenes never leave your
machine.

![Kiln editing a subdivided form](docs/screenshot.png)

```bash
git clone https://github.com/22500107zc/yes.git kiln
cd kiln
npm install
npm start       # builds, then opens http://localhost:4173
```

Use `npm run dev` instead while you are working on Kiln itself — same app, with
hot reload. Kiln needs a browser with WebGL2 (Chrome, Firefox, Edge and Safari
15+ all work).

### Install it as a desktop app

Kiln is a web app, so there is no installer to download — but it installs like
a native one. With `npm start` running, in **Chrome or Edge**:

- **macOS** — open the ⋮ menu ▸ *Cast, Save and Share* ▸ **Install page as app**.
  Kiln lands in `~/Applications/Chrome Apps` and shows up in Spotlight and the
  Dock like anything else.
- **Windows** — ⋮ ▸ *Apps* ▸ **Install this site as an app**. It gets a Start
  menu entry and can be pinned to the taskbar.
- **Linux** — ⋮ ▸ *Cast, Save and Share* ▸ **Install page as app**, which writes
  a normal `.desktop` entry.

Installed, Kiln opens in its own window with no browser chrome, and it keeps
working with the dev server stopped and the network off — the service worker
caches the whole app, which is under 200 KB. Safari and Firefox have no
install command; **File ▸ Add to Dock** in Safari 17+ is the closest equivalent.

To host it for yourself instead, `npm run build` and serve `dist/` from
anywhere — it is plain static files. Opening `dist/index.html` straight off
disk will *not* work: browsers block ES modules over `file://`.

---

## Why this exists

Blender is extraordinary and Kiln is not trying to replace it. What Kiln
replaces is the *first ten minutes*: downloading a 300 MB package to box-model
a shape, check a silhouette, clean up a scanned mesh, or convert an OBJ to
glTF. Kiln opens in a tab, uses Blender's keymap so your hands already know it,
and everything you make stays on your machine — there is no server.

The whole application is about 7,000 lines of dependency-free TypeScript: the
mesh kernel, the renderer, the modifiers and the UI are all in this repository
and all readable in an afternoon.

## What works today

**Modelling**
- Vertex, edge and face select modes with box select, edge-ring select and
  x-ray selection
- Extrude region (constrained to the face normal), inset with live preview,
  loop cut with a scroll-adjustable cut count and on-canvas preview
- Subdivide, dissolve, merge (at centre and by distance), make face, delete,
  duplicate, triangulate, smooth, flip and recalculate normals
- Modal transforms exactly as you expect: `G`/`R`/`S`, `X`/`Y`/`Z` to constrain,
  `Shift`+axis for a plane, typed numeric input, `Ctrl` to snap, `Shift` for
  precision, `Esc` to cancel

**Scene**
- Object hierarchy with parenting, per-object visibility and locking
- Point, sun, spot and area lights; camera objects you can look through
- PBR materials (base colour, metallic, roughness, emission, alpha) with
  per-face material slots
- Non-destructive modifiers: Subdivision Surface (Catmull–Clark), Mirror,
  Array, Solidify, Weld, Triangulate and Smooth — reorderable, toggleable,
  applyable

**Viewport**
- Solid (studio-lit), Material (scene-lit PBR) and Wireframe shading
- Infinite grid that re-scales by powers of ten, selection outlines, edit-mode
  overlays, light and camera gizmos, a 3D cursor
- Orbit/pan/zoom, orthographic toggle, numpad axis views, frame selected/all

**Files**
- Save and open scenes as `.kiln` (plain JSON — diffable, scriptable)
- Import OBJ; export OBJ + MTL, binary STL, and glTF 2.0 with
  `KHR_lights_punctual`
- Snapshot undo/redo across every operation, including modifier edits

## Keyboard

| | |
|---|---|
| `Tab` | Object Mode ⇄ Edit Mode |
| `1` `2` `3` | Vertex / edge / face select |
| `G` `R` `S` | Move, rotate, scale — then `X`/`Y`/`Z`, or type a number |
| `E` `I` `Ctrl+R` | Extrude, inset, loop cut |
| `M` `F` `X` `Ctrl+X` | Merge, make face, delete, dissolve |
| `A` `Alt+A` `Ctrl+I` | Select all / none / invert |
| `Shift+D` `Ctrl+J` `Ctrl+A` | Duplicate, join, apply transform |
| `Z` `Alt+Z` | Cycle shading, toggle x-ray |
| `Numpad 1/3/7` `5` `0` | Front / right / top, orthographic, camera view |
| `.` `Home` | Frame selected, frame all |
| `Ctrl+Z` `Ctrl+Shift+Z` | Undo, redo |

Middle-drag orbits, `Shift`+middle pans, the wheel zooms, `Shift`+right click
places the 3D cursor. The full list lives behind **Shortcuts** in the menu bar.

## How it is built

```
src/
  core/math.ts        Vec3, Mat4, AABB, ray intersection, matrix decomposition
  mesh/               The geometry kernel
    Mesh.ts             n-gon polygon mesh + cached derived topology
    primitives.ts       Blender-compatible primitive builders
    ops.ts              extrude, inset, loop cut, Catmull-Clark, merge, dissolve…
  modifiers/          Non-destructive stack; each modifier is mesh -> mesh
  scene/              Scene graph, materials, lights, the orbit camera
  render/             WebGL2 forward renderer, GLSL, buffer builders
  editor/             Modes, selection, CPU picking, modal transforms, undo,
                      the command registry and keymap
    selection.ts        Mode-authoritative selection derivation
  ui/                 Plain-DOM shell: header, toolbar, outliner, properties
```

Three decisions shape everything else:

**The mesh is an n-gon soup with derived adjacency.** `Mesh` stores positions
and polygon corner lists; `Mesh.topology()` builds edges, vertex/face
adjacency and normals on demand and caches them against a revision counter.
Operators get half-edge-quality queries without the cost of keeping a half-edge
structure valid through every edit, and serialization, undo and export all stay
trivial. Extrude and inset share one primitive — `splitRegion` detaches a face
region along its boundary and bridges the gap — so they can never disagree
about topology.

**Picking happens on the CPU.** Rays are cast against triangles and elements
are matched in screen space, rather than reading back a GPU id buffer. No
pipeline stall, no second render pass, and "nearest within N pixels, preferring
what is in front" is expressed directly.

**Selection is mode-authoritative.** Whichever of vertex/edge/face mode you are
in owns its set, and the other two are derived from it with Blender's
conversion rules. Deriving everything from vertices is simpler but wrong: an
edge ring around a closed shape has every corner as an endpoint, so a
vertex-derived edge set would light up the whole mesh.

**Undo takes whole-scene snapshots.** Memory in exchange for correctness: every
operator, however exotic, is undoable without anybody writing a matching
inverse. A modal transform pushes one snapshot before it starts, so cancelling
an extrude rolls back the extrusion *and* the move.

## Development

```bash
npm run dev         # Vite dev server with HMR
npm run typecheck   # tsc --noEmit, strict
npm test            # 56 unit tests over the kernel, scene, selection, modifiers and IO
npm run build       # typecheck + production bundle into dist/
```

`dist/` is a static folder — drop it on any host, no backend required.

The tests are the specification for the geometry kernel. They assert real
invariants (a cube stays a closed manifold through extrude and loop cut,
Catmull–Clark converges toward a sphere while pinning open boundaries, solidify
produces watertight output) rather than snapshotting numbers, so they catch
genuine topology regressions.

## Not there yet

Honest list of what Blender has that Kiln does not: bevel, knife and
poly-build tools, UV unwrapping and texturing, sculpting, rendering beyond the
viewport, animation and rigging, physics, geometry nodes, and Python scripting.
Meshes above roughly a million triangles will also make the viewport
uncomfortable — surfaces are uploaded unindexed today.

Bevel, UV unwrapping and a knife tool are next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Small, focused pull requests with a test
for anything touching `src/mesh` are the easiest to merge.

## Licence

MIT — see [LICENSE](LICENSE). Kiln contains no Blender code; the resemblance is
in the keymap, which is deliberate.
