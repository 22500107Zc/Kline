# Contributing to Kiln

Thanks for taking a look. Kiln is small enough that you can read the whole thing
before changing it, and the fastest way to get a change merged is to keep it
that way.

## Getting set up

```bash
npm install
npm run dev
```

Requires Node 22+ and a WebGL2-capable browser. There are no runtime
dependencies and there is no backend — if a change adds either, say why in the
pull request.

## Before you push

```bash
npm run typecheck   # strict TypeScript, no implicit any, no unused locals
npm test            # node:test over the kernel, scene, modifiers and IO
npm run build       # make sure the production bundle still builds
npm run app         # if you touched electron/ or src/desktop.ts
```

CI runs the first three, then boots the desktop shell under Xvfb and
screenshots it.

The shell has to stay optional: `src/desktop.ts` is the only place allowed to
reach for `window.kilnDesktop`, and every call through it needs a browser
fallback. One bundle ships to both targets.

## Where things live

| Area | Path | Notes |
|---|---|---|
| Geometry kernel | `src/mesh` | Pure, DOM-free, fully unit tested |
| Modifiers | `src/modifiers` | Each one is a pure `Mesh -> Mesh` function |
| Scene graph | `src/scene` | Objects, materials, lights, orbit camera |
| Renderer | `src/render` | WebGL2 only; GLSL lives in `shaders.ts` |
| Editor | `src/editor` | Modes, picking, modal operators, undo, commands |
| UI | `src/ui` | Plain DOM, no framework |
| Desktop shell | `electron` | Window, native menu and file dialogs (CommonJS) |

## House rules

**Anything in `src/mesh` needs a test.** Assert an invariant, not a number:
"the mesh is still a closed manifold", "the volume is unchanged", "every face
is a quad". `tests/mesh.test.ts` has helpers for closedness and signed volume.

**Operators mutate in place and report what moved.** Follow the shape of the
existing ones: take the mesh plus a selection, keep existing face indices stable
where you can, call `mesh.markDirty()` before returning, and return whatever the
caller needs to rebuild its selection.

**New user-facing actions go in the command registry.** Add an entry to
`COMMANDS` in `src/editor/commands.ts` and, if it deserves a key, a `KEYMAP`
binding. Menus, the toolbar and the shortcut sheet all read from those two
lists, so you get the UI for free — and a test checks that every advertised
shortcut is actually bound.

**Match the keymap to Blender where one exists.** Muscle memory is the point.
If Blender has no equivalent, pick something unclaimed and document it.

**Undo is a snapshot.** Call `editor.beginUndo('Label')` *before* mutating.
Compound operators (extrude-then-move) push one snapshot and pass
`pushUndo = false` to `startTransform`, so cancelling rolls the whole thing back.

## Reporting bugs

Geometry bugs are much easier to fix with a failing test than a description. If
you can, attach the smallest mesh that reproduces it — a `.kiln` file from
**File ▸ Save Scene** is ideal.
