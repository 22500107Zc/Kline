# Kiln

**A 3D modelling application for your desktop — and your browser.** Kiln is an
open source alternative to Blender's modelling workflow: mesh editing with
bevel and booleans, sculpting, UV unwrapping, keyframe animation, a
non-destructive modifier stack, PBR materials, a path-traced renderer and glTF
export — in dependency-free TypeScript. Drop in a photo or a video and it
builds geometry from it. No account, no server; nothing you open ever leaves
your machine.

![Kiln editing a subdivided form](docs/screenshot.png)

Kiln runs two ways: as a **desktop app** you double-click, or as a page in a
browser tab. Same code either way.

### Get the desktop app

Grab the build for your platform from the
[Releases page](https://github.com/22500107zc/yes/releases):

- **macOS** — `Kiln-0.1.0-universal.pkg`, one file for both Apple Silicon and
  Intel, which installs Kiln straight into Applications. (A `.dmg` and a zipped
  `Kiln.app` are there too, if you prefer.)
- **Windows** — an `.exe` installer, or a portable `.exe` that needs no install.
- **Linux** — `.AppImage` or `.deb`. Kiln gets a Dock/Start-menu entry and a desktop shortcut, opens
`.kiln` files on double-click, and has a real menu bar with native Open and
Save dialogs.

These builds are **unsigned**, so the first launch needs one extra step:

- **macOS** — right-click the `.pkg` (or the app) ▸ **Open** ▸ **Open**, once.
  (If it says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/Kiln.app`.)
- **Windows** — SmartScreen shows "Windows protected your PC" ▸ **More info** ▸
  **Run anyway**, once.
- **Linux** — `chmod +x Kiln-*.AppImage`, then run it.

### Or build it yourself

```bash
git clone https://github.com/22500107zc/yes.git kiln
cd kiln
npm install

npm run app     # build and launch the desktop app
npm run dist    # build an installer for the machine you are on -> release/
npm run dev     # web version with hot reload, for working on Kiln itself
```

`npm run dist` only builds for the OS it runs on — macOS installers need a Mac.
The release workflow builds all three on tag push.

### Or just use the browser

```bash
npm start       # builds, then opens http://localhost:4173
```

Chrome and Edge can install that page as a standalone app too (⋮ ▸ *Install page
as app*), which is lighter than the Electron build and works offline once
cached. Kiln needs WebGL2 — Chrome, Firefox, Edge and Safari 15+ all have it.
Opening `dist/index.html` straight off disk will *not* work: browsers block ES
modules over `file://`.

---

## Just say what you want

There is a **Build** box across the top of the viewport. Type into it, press
Enter, and a model writes a short program that builds what you asked for.

```
a spiral staircase with 30 steps      a gear with 24 teeth
a suspension bridge                    a chess rook
a city block of towers                 a DNA double helix
```

![Two 24-tooth gears and a sphere helix, built from generated programs](docs/build-from-code.png)

The program is real code against a small geometry API — `box`, `cyl`,
`sphere`, `cone`, `torus`, `part`, plus loops and trigonometry — so the ceiling
is what the model can express, not a list somebody wrote in advance. Press
**Code** to read it, edit it and re-run. A gear is a loop; a staircase is a
loop; a city is a nested loop. That is why this is code and not a menu.

Generated code is untrusted, so it runs in a Worker with `fetch`, storage and
the DOM removed, a part budget and a three-second limit — an infinite loop gets
terminated instead of freezing the app. All it can do is return a list of
primitives, which goes through the same validator as everything else.

### You need a model for this

Arbitrary requests need something that can write arbitrary programs. **Ollama
is the only genuinely free-forever option**, because it runs on your machine:

```bash
# install Ollama, then:
ollama pull qwen2.5-coder:7b     # or llama3.2 on a smaller machine
ollama serve
```

Click the chip at the right of the Build box, press **Connect**, and you are
done. Kiln defaults to `http://127.0.0.1:11434`.

Any OpenAI-compatible endpoint works too — Groq and OpenRouter have free tiers,
LM Studio and llama.cpp are local. Be clear-eyed about hosted "free": those
tiers are free *today*, rate-limited, and need an account. Nobody serves GPUs
for nothing indefinitely, so local is the only zero anyone can promise.

Coding models do this better than chat models. When one writes something that
does not run, Kiln hands the error back and asks again — which is usually
enough.

### Without a model

Two things still work with nothing installed:

- **Write the code yourself.** Press **Code** and use the same API. No model, no
  network, no cost.
- **Built-in subjects.** Twenty-one procedural recipes (table, chair, house,
  tree, castle, robot, rocket, car, snowman, stairs, and so on) plus shape
  arrangements: `12 cubes in a circle`, `stack of 8 spheres`, `9 cylinders in a
  grid`. Instant and offline, but a fixed list — which is exactly why the code
  path exists.

Every build lands as a group of ordinary editable meshes. Tab into Edit Mode and
keep going.

## Quick keys

| | |
|---|---|
| `Cmd/Ctrl + K` | Search every command — the fastest way to find anything |
| `Cmd/Ctrl + Shift + B` | Jump to the Build box |
| `Cmd/Ctrl + U` | UV editor |
| `F12` | Render the image |
| `?` | The full keyboard sheet |

The palette lists commands from the other mode too, marked, so you can discover
that Recalculate Normals lives in Edit Mode instead of finding nothing.

---

## Build from a reference

![A traced mug reference extruded into a solid, hole and all](docs/reference-to-mesh.png)

Drag an image or a video anywhere onto the window. Kiln reads it locally, traces
it, and builds a mesh straight away — then rebuilds that same object as you
adjust the settings, with the detected outline drawn over your reference so the
threshold is something you can see rather than guess. Videos are scrubbable, so
any frame can be the source.

| Mode | What it does | Good for |
|---|---|---|
| **Cut Out** | Traces the outline and extrudes it into a solid, holes included | Logos, signage, silhouettes, flat parts |
| **Turn** | Revolves the profile around a vertical axis | Vases, bottles, turned legs, anything round |
| **Relief** | Displaces a grid by image brightness | Carvings, terrain, depth maps, stamps |

These are deterministic geometry, not a model: no weights to download, no GPU,
no network, a few milliseconds per rebuild. What comes out is an ordinary
editable mesh — press Tab and keep modelling.

### Hooking up a local AI model

For genuine single-image reconstruction (TripoSR, InstantMesh, TRELLIS,
Hunyuan3D and friends), Kiln talks to a model server you run yourself. It does
not bundle weights — those are gigabytes and want a GPU — but the other half is
in the box:

```bash
python3 tools/kiln-ai-server.py                  # echo backend, verifies the wiring
python3 tools/kiln-ai-server.py --backend triposr
```

Then in Kiln: **Create ▸ Local AI model ▸ Check ▸ Generate 3D**. The server
defaults to `127.0.0.1`, so your images stay on your machine unless you
deliberately point it somewhere else.

The contract is two endpoints, so pointing Kiln at your own pipeline means
writing one function:

```
GET  /health    -> {"name": str, "models": [str], "detail": str}
POST /generate  -> multipart: image, model, prompt, detail
                <- an OBJ, or {"format":"obj","data":"...","seconds":float}
```

The included `--backend triposr` implementation is a reference: it is written
against TripoSR's published API but needs you to install the model and its
weights, and it has not been run in this repository's CI, which has no GPU. The
`echo` backend is exercised end to end and is there so you can confirm the
connection before installing anything.

---

## Why this exists

Blender is extraordinary and Kiln is not trying to replace it. What Kiln
replaces is the *first ten minutes*: downloading a 300 MB package to box-model
a shape, check a silhouette, clean up a scanned mesh, or convert an OBJ to
glTF. Kiln opens in a tab, uses Blender's keymap so your hands already know it,
and everything you make stays on your machine — there is no server.

The whole application is dependency-free TypeScript: the mesh kernel, the
renderer, the path tracer, the sculpt brushes, the unwrapper, the modifiers and
the UI are all in this repository, and each piece is readable on its own.

## What works today

**Say what you want**
- A Build box where a local model writes a program that builds what you asked for
- A sandboxed geometry API you can also write against by hand, with no model
- 21 procedural subjects and shape arrangements as the offline fallback
- Command palette over every operation in the app

**From a reference**
- Drop an image or video anywhere in the window; scrub a video to pick a frame
- Cut Out, Turn and Relief generators, rebuilt live as you tune them
- Automatic subject detection by brightness, transparency or a single channel
- Optional bridge to a local image-to-3D model server

**Modelling**
- Vertex, edge and face select modes with box select, edge-ring select and
  x-ray selection
- **Bevel** (`Ctrl+B`) with drag-to-width, scroll-to-segments and a profile
  control. The arc is centred where a real fillet's is, so a rounded cube comes
  out with the volume Steiner's formula says it should have; the width clamps
  globally rather than per corner, so it stays even instead of pinching; and
  per-edge weights let one operation round the hard corners heavily and leave
  the soft ones alone
- **Booleans** — union, difference and intersect, destructively or as a live
  modifier pointed at another object. Surface-based rather than BSP, so two
  curved surfaces meeting almost tangentially cost nothing special — the case
  that hangs a BSP boolean finishes here in about 60ms — and the result is
  repaired back to a closed solid rather than left with hairline cracks
- Extrude region (constrained to the face normal), inset with live preview,
  loop cut with a scroll-adjustable cut count and on-canvas preview
- **Knife** (`K`) — click a line over the model and it cuts along it, sharing
  the new vertices between both faces on every edge it crosses so the seam is
  a seam and not a hairline crack
- Bisect with a cap, spin/revolve, bridge edge loops, symmetrize, poke,
  limited dissolve, T-junction repair
- **Decimate** by quadric error metrics — cut a scan or a subdivided mesh to a
  tenth of its triangles with the silhouette intact
- Subdivide, dissolve, merge (at centre and by distance), make face, delete,
  duplicate, triangulate, smooth, flip and recalculate normals
- **Proportional editing** (`O`) with six falloff curves, straight-line or
  measured along the surface, radius on the scroll wheel
- **Snapping** (`Shift+Tab`) to increment, absolute grid, vertex, edge or face
- Modal transforms exactly as you expect: `G`/`R`/`S`, `X`/`Y`/`Z` to constrain,
  `Shift`+axis for a plane, typed numeric input, `Ctrl` to invert snapping,
  `Shift` for precision, `Esc` to cancel

**Sculpting**
- Eleven brushes: draw, smooth, inflate, grab, flatten, scrape, pinch, crease,
  mask, weight and colour
- Dabs land at a fixed spacing along the stroke, so the same gesture gives the
  same result whether you draw it fast or slowly
- **Voxel remesh** — rebuild the topology at an even density from the shape
  alone, for when a limb you pulled out has run out of polygons
- **Masking** holds part of the model still, so you can sculpt a face without
  dragging the ear along with it
- Radius, strength and auto-smooth; `Ctrl` inverts, `[` and `]` resize
- X/Y/Z symmetry, and a brush ring drawn on the surface so you can see the
  falloff before you commit to it

**UVs and texturing**
- **Unwrap** (`U`) with least-squares conformal maps, cut along seams you mark
  or where the surface folds past an angle limit
- Smart, cube, cylinder, sphere and planar projection
- Islands packed at a shared texel density by a MaxRects packer that tries
  several orderings and bin widths, so one texture resolves the whole model
  evenly and does not spend half of itself on air
- A UV editor (`Cmd/Ctrl+U`) that shades every face by stretch — a wireframe
  layout cannot show the thing that actually ruins a texture — and lets you
  drag the coordinates directly
- **Texture painting** straight onto the model, stamped once per face so a
  seam gets painted from both sides and does not show as a gap
- **Vertex colours**, for getting colour onto something without unwrapping it
  first
- Image textures with tiling and offset, plus a generated UV checker

**Animation**
- Keyframes on location, rotation and scale, with constant, linear and
  auto-eased bezier interpolation
- Keyframes on properties too: light power and colour, camera field of view,
  material colour, roughness, metallic, alpha and emission
- A **graph editor** (`Cmd/Ctrl+G`) that draws the actual curves — drag keys to
  retime or revalue them, and see the easing rather than guessing at it
- A timeline with a scrubbable playhead, keyframe markers, frame range, fps
  and looping playback
- Exported into glTF as real animation samplers

**Rigging**
- Armatures with bones you extrude into a chain, drawn as octahedra so their
  roll is visible
- **Bind with automatic weights** in one step — weights, modifier and link
- Four bone influences per vertex, saved with the mesh so subdividing carries
  them
- A weight brush for fixing what the automatic pass got wrong

**Physics**
- Rigid bodies, active and passive, as boxes or spheres
- **Bake to keyframes** over the timeline, after which nothing depends on the
  solver — the animation is the artefact
- Sequential-impulse contacts with positional correction, so a stack settles
  instead of sinking or shuffling

**Rendering**
- A **path-traced renderer**: BVH-accelerated, metallic-roughness GGX, soft
  shadows from sized lights, a sky dome and global illumination
- **Glass** — transmission and index of refraction, with total internal
  reflection, and shadow rays that pass through it instead of treating a window
  as a brick
- **Emissive surfaces sampled directly**, with multiple importance sampling, so
  an emission plane lights a room cleanly instead of as noise
- **Depth of field** from a camera aperture and focus distance
- An **edge-aware denoiser** guided by surface colour, normal and depth, so a
  low-sample preview is usable — noise falls off as the square root of samples,
  which makes the last of the speckle the most expensive part of the image
- Progressive — the image refines pass by pass, across every core the machine
  has, and you can re-grade the exposure or toggle the denoiser without
  restarting
- Save the result as a PNG

**Scene**
- Object hierarchy with parenting, per-object visibility and locking
- Point, sun, spot and area lights; camera objects you can look through
- PBR materials (base colour, metallic, roughness, emission, alpha) with
  per-face material slots
- Non-destructive modifiers: Subdivision Surface (Catmull–Clark), Mirror,
  Array, Solidify, Weld, Triangulate, Smooth, **Boolean**, **Decimate** and
  **Bevel** — reorderable, toggleable, applyable

**Viewport**
- Solid (studio-lit), Material (scene-lit PBR) and Wireframe shading
- **Shadow mapping** from the strongest sun or spot, filtered so the edges are
  soft rather than stepped
- Mipmapped, anisotropically filtered textures — without them a textured floor
  shimmers on every camera move
- Infinite grid that re-scales by powers of ten, selection outlines, edit-mode
  overlays, light and camera gizmos, a 3D cursor
- Orbit/pan/zoom, orthographic toggle, numpad axis views, frame selected/all

**Files**
- Save and open scenes as `.kiln` (plain JSON — diffable, scriptable)
- Import OBJ; export OBJ + MTL, binary STL, and glTF 2.0 with
  `KHR_lights_punctual`
- Snapshot undo/redo across every operation, including modifier edits. Snapshots
  share the meshes an edit did not touch, so editing one object in a scene of
  twenty no longer copies all twenty, and the history is bounded by memory as
  well as by a step count
- Crash-recovery autosave to IndexedDB, which has room for a real scene — five
  rolling copies, offered rather than restored silently, because the one you
  want back is often not the newest

## Keyboard

| | |
|---|---|
| `Tab` | Object Mode ⇄ Edit Mode |
| `1` `2` `3` | Vertex / edge / face select |
| `G` `R` `S` | Move, rotate, scale — then `X`/`Y`/`Z`, or type a number |
| `E` `I` `Ctrl+R` `Ctrl+B` | Extrude, inset, loop cut, bevel |
| `K` | Knife — click points, `Enter` to cut |
| `U` | Unwrap the selection |
| `Cmd/Ctrl+U` `Cmd/Ctrl+G` | UV editor, graph editor |
| `O` `Shift+Tab` | Proportional editing, snapping |
| `I` `Alt+I` | Insert / delete keyframe (Object Mode) |
| `Space` `←` `→` | Play, step a frame |
| `F12` | Render the image |
| `M` `F` `X` `Ctrl+X` | Merge, make face, delete, dissolve |
| `A` `Alt+A` `Ctrl+I` | Select all / none / invert |
| `Shift+D` `Ctrl+J` `Ctrl+A` | Duplicate, join, apply transform |
| `Z` `Alt+Z` | Cycle shading, toggle x-ray |
| `Numpad 1/3/7` `5` `0` | Front / right / top, orthographic, camera view |
| `.` `Home` | Frame selected, frame all |
| `Ctrl+Z` `Ctrl+Shift+Z` | Undo, redo |

### Moving around the viewport

| Trackpad | Mouse | |
|---|---|---|
| `Option` + drag | Middle-drag | Orbit |
| `Option`+`Shift` + drag, or `Shift` + two-finger scroll | `Shift` + middle-drag | Pan |
| Two-finger scroll, or pinch | Wheel | Zoom |

`Shift` + right click places the 3D cursor. `.` frames what is selected and
`Home` frames everything — handy when you have lost the object off screen. The
full list lives behind **Shortcuts** in the menu bar.

## How it is built

```
electron/            Desktop shell: window, native menu, file dialogs
src/
  core/math.ts        Vec3, Mat4, AABB, ray intersection, matrix decomposition
  mesh/               The geometry kernel
    Mesh.ts             n-gon polygon mesh + cached derived topology
    primitives.ts       Blender-compatible primitive builders
    ops.ts              extrude, inset, loop cut, Catmull-Clark, merge, dissolve…
  imaging/            Reference to geometry
    contour.ts          Thresholding, marching-squares tracing, simplification
    triangulate.ts      Ear clipping with hole bridging
    generate.ts         Silhouette, lathe and heightfield builders
  ai/client.ts        Client for a local image-to-3D server
  build/              Say-what-you-want
    plan.ts             The build DSL, validation and execution
    sandbox.ts          Geometry API; runs generated code in a locked-down Worker
    llm.ts              Ollama / OpenAI-compatible code generation
    recipes.ts          Procedural subjects, for when no model is connected
    interpreter.ts      Offline prompt -> plan
    bevel.ts            Fan-based bevel: sectors, profiles, corner patches
    csg.ts              Surface-based booleans: BVH crossings, cut, classify
    bvh.ts              Triangle BVH: box queries, raycasts, inside tests
    boolean.ts          Post-cut repair: coplanar dissolve, stitching, manifold
    knife.ts            Screen-space cutting with shared seam vertices
    remesh.ts           Signed distance field + marching cubes
    skin.ts             Bone weights, envelope binding, linear blend skinning
    modeling.ts         Bisect, spin, bridge, symmetrize, poke
    decimate.ts         Quadric error metric simplification
  uv/
    unwrap.ts           Islands, LSCM flattening, projections
    pack.ts             MaxRects island packing
    transfer.ts         Resampling coordinates across an edit
  paint/texture.ts    Painting onto a texture through the UV layout
  sculpt/sculpt.ts    Brushes, falloff and the hash grid they query
  physics/            Rigid bodies, and baking them down to keyframes
  anim/
    animation.ts        Channels, interpolation, sampling
    armature.ts         Bones, pose evaluation, skinning matrices
  modifiers/          Non-destructive stack; each modifier is mesh -> mesh
  scene/              Scene graph, materials, lights, the orbit camera
  render/             WebGL2 forward renderer, GLSL, buffer builders
    pathtrace/          BVH, GGX path tracer, worker pool, progressive job
      denoise.ts          Edge-aware a-trous filter, guided by the first hit
  editor/             Modes, selection, CPU picking, modal transforms, undo,
                      the command registry and keymap
    selection.ts        Mode-authoritative selection derivation
  ui/                 Plain-DOM shell: header, toolbar, outliner, properties
  desktop.ts          Bridge to the Electron host; a no-op in a browser tab
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

**Undo takes whole-scene snapshots, but shares what did not change.** Snapshots
in exchange for correctness: every operator, however exotic, is undoable
without anybody writing a matching inverse. The obvious cost — copying every
mesh in the scene on every edit — is avoided by serializing each mesh once per
revision and letting every snapshot point at the same frozen blob, so the work
is proportional to what the edit touched. A modal transform pushes one snapshot
before it starts, so cancelling an extrude rolls back the extrusion *and* the
move.

**Booleans work on surfaces, not on a tree of planes.** The classic BSP
approach splits every polygon against every plane it meets, which is fine on
flat operands and never finishes on two rounded surfaces meeting almost
tangentially. Kiln finds the triangle pairs that actually cross through a BVH,
cuts only those, and classifies each piece by ray parity — so the work is
proportional to the number of crossings rather than to their arrangement.
Floating point still leaves the occasional sliver, and no tolerance setting
removes those without eating real detail, so the result is repaired back to a
closed solid instead.

## Development

```bash
npm run dev         # Vite dev server with HMR
npm run typecheck   # tsc --noEmit, strict
npm test            # everything below
npm run test:unit   # 349 unit tests over the kernel, operators, UVs, sculpting,
                    # animation, the path tracer, the scene and IO
npm run test:app    # 14 tests in a real browser: shadows land, overlays draw,
                    # strokes and rigs reach the screen, clicks and modals
                    # behave. Skipped if no Chromium is found.
npm run build       # typecheck + production bundle into dist/
npm run app         # run the desktop shell against the built bundle
npm run dist        # package installers for the current OS into release/
```

`dist/` is a static folder — drop it on any host, no backend required.

The tests are the specification for the geometry kernel. They assert real
invariants (a cube stays a closed manifold through extrude and loop cut,
Catmull–Clark converges toward a sphere while pinning open boundaries, solidify
produces watertight output) rather than snapshotting numbers, so they catch
genuine topology regressions.

The browser suite covers the part no unit test can reach. Three bugs shipped
through that gap — a shadow pass that silently drew nothing, a click that threw
away the selection it had just confirmed, an axis whose labels ran together —
and each was found by looking at the screen rather than by running the suite.
So `tests/app.test.mjs` renders real frames under SwiftShader and reads the
pixels back, and drives real pointer and key input. Every test in it was
written against a failure that actually reached a user, and each was checked by
putting the bug back and watching it go red. It needs Playwright and a Chromium
build; without either it skips with a reason and the rest still runs.

## Not there yet

Honest list of what Blender has that Kiln does not:

- **Geometry nodes** and **Python scripting.** The Build box writes JavaScript
  against a sandboxed geometry API instead, and `kiln.editor` in the browser
  console reaches the live scene.
- **Inverse kinematics and constraints.** Bones are posed directly; there is no
  IK chain, no copy-rotation, no drivers.
- **Shape keys** and **non-linear animation.** One action per object, no NLA
  strips, no blending between takes.
- **Cloth, fluid, smoke and particles.** Physics here is rigid bodies only.
- **Dynamic topology while sculpting.** Voxel remesh rebuilds the whole mesh at
  an even density; the brushes themselves move the vertices that are there.
- **A node-based shader editor.** Materials are a fixed metallic-roughness set
  with one base colour map.
- **UDIMs and multiple UV maps.** One layout, one 1024² paint map per material.
- **Convex hulls and mesh colliders** for physics. Bodies are boxes or spheres
  fitted to the bounds.

Also true, and worth knowing before you rely on it: the path tracer runs on the
CPU, so a large image at a high sample count is minutes rather than seconds;
one light casts viewport shadows rather than all of them; box-box physics
contacts ignore rotation, so a tumbling crate settles as an upright one;
reference images cannot be pinned in the viewport to model against;
photogrammetry from a video's many frames is not implemented; and meshes above
roughly a million triangles make the viewport uncomfortable, because surfaces
are uploaded unindexed — which is deliberate, since flat shading, per-face
materials and per-face selection all need attributes that differ between the
faces meeting at a vertex.

The desktop builds are **unsigned**, and signing them needs certificates that
cost money rather than code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Small, focused pull requests with a test
for anything touching `src/mesh` are the easiest to merge.

## Licence

MIT — see [LICENSE](LICENSE). Kiln contains no Blender code; the resemblance is
in the keymap, which is deliberate.
