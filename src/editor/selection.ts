import { Mesh } from '../mesh/Mesh';
import { SelectMode } from '../render/Renderer';

export interface ElementSelection {
  verts: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
}

export function emptySelection(): ElementSelection {
  return { verts: new Set(), edges: new Set(), faces: new Set() };
}

/**
 * Re-derive the two passive selection sets from the authoritative one.
 *
 * Which set is authoritative depends on the mode the selection was made in.
 * That is what keeps an edge-ring pick a ring: deriving edges from vertices
 * would light up every edge whose endpoints happen to be selected, which for a
 * ring around a closed shape is the entire mesh.
 *
 * The rules match Blender's mode-switch conversions:
 *  - from vertices: an edge/face is selected when *all* of its vertices are;
 *  - from edges:    vertices are the endpoints, a face needs all its edges;
 *  - from faces:    vertices and edges are everything the faces touch.
 */
export function deriveSelection(mesh: Mesh, selection: ElementSelection, from: SelectMode): void {
  const t = mesh.topology();

  if (from === 'vertex') {
    const verts = selection.verts;
    const edges = new Set<number>();
    for (let e = 0; e < t.edges.length; e++) {
      const rec = t.edges[e];
      if (verts.has(rec.a) && verts.has(rec.b)) edges.add(e);
    }
    const faces = new Set<number>();
    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      if (loop.length > 0 && loop.every((v) => verts.has(v))) faces.add(f);
    }
    selection.edges = edges;
    selection.faces = faces;
    return;
  }

  if (from === 'edge') {
    const selected = selection.edges;
    const verts = new Set<number>();
    for (const e of selected) {
      const rec = t.edges[e];
      if (!rec) continue;
      verts.add(rec.a);
      verts.add(rec.b);
    }
    const faces = new Set<number>();
    for (let f = 0; f < mesh.faces.length; f++) {
      const fe = t.faceEdges[f];
      if (fe.length > 0 && fe.every((e) => e >= 0 && selected.has(e))) faces.add(f);
    }
    selection.verts = verts;
    selection.faces = faces;
    return;
  }

  const verts = new Set<number>();
  const edges = new Set<number>();
  for (const f of selection.faces) {
    for (const v of mesh.faces[f] ?? []) verts.add(v);
    for (const e of t.faceEdges[f] ?? []) if (e >= 0) edges.add(e);
  }
  selection.verts = verts;
  selection.edges = edges;
}

/** How many elements of a given kind the mesh has — used by select all/invert. */
export function elementCount(mesh: Mesh, mode: SelectMode): number {
  return mode === 'vertex' ? mesh.vertCount : mode === 'edge' ? mesh.edgeCount : mesh.faceCount;
}

/** Drop indices that no longer exist after a topology change. */
export function pruneSelection(mesh: Mesh, selection: ElementSelection): void {
  const t = mesh.topology();
  for (const v of [...selection.verts]) if (v >= mesh.vertCount) selection.verts.delete(v);
  for (const e of [...selection.edges]) if (e >= t.edges.length) selection.edges.delete(e);
  for (const f of [...selection.faces]) if (f >= mesh.faceCount) selection.faces.delete(f);
}
