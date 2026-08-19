import { Mesh } from '../mesh/Mesh';

/**
 * CPU-side vertex buffer construction. Triangles are emitted unindexed so that
 * flat shading, per-face materials and per-face selection all work without
 * splitting draws.
 */

export const SURFACE_STRIDE = 8; // pos(3) normal(3) flags(1) matId(1)
export const LINE_STRIDE = 6; // pos(3) color(3)
export const POINT_STRIDE = 4; // pos(3) flags(1)

export interface BufferData {
  data: Float32Array;
  count: number;
}

export function buildSurface(mesh: Mesh, selectedFaces: Set<number> | null): BufferData {
  const t = mesh.topology();
  const tris = mesh.triCount;
  const data = new Float32Array(tris * 3 * SURFACE_STRIDE);
  let o = 0;

  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    if (loop.length < 3) continue;
    const smooth = mesh.isFaceSmooth(f);
    const fn = t.faceNormals[f];
    const flag = selectedFaces && selectedFaces.has(f) ? 1 : 0;
    const mat = mesh.faceMaterial[f] ?? 0;
    for (let i = 1; i + 1 < loop.length; i++) {
      for (const v of [loop[0], loop[i], loop[i + 1]]) {
        const p = mesh.positions[v];
        const n = smooth ? t.vertNormals[v] : fn;
        data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
        data[o++] = n.x; data[o++] = n.y; data[o++] = n.z;
        data[o++] = flag;
        data[o++] = mat;
      }
    }
  }
  return { data, count: tris * 3 };
}

export function buildWire(
  mesh: Mesh,
  selectedEdges: Set<number> | null,
  base: readonly [number, number, number],
  selected: readonly [number, number, number],
): BufferData {
  const t = mesh.topology();
  const n = t.edges.length;
  const data = new Float32Array(n * 2 * LINE_STRIDE);
  let o = 0;
  for (let e = 0; e < n; e++) {
    const rec = t.edges[e];
    const c = selectedEdges && selectedEdges.has(e) ? selected : base;
    for (const v of [rec.a, rec.b]) {
      const p = mesh.positions[v];
      data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
      data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2];
    }
  }
  return { data, count: n * 2 };
}

export function buildPoints(mesh: Mesh, selectedVerts: Set<number> | null): BufferData {
  const n = mesh.positions.length;
  const data = new Float32Array(n * POINT_STRIDE);
  let o = 0;
  for (let v = 0; v < n; v++) {
    const p = mesh.positions[v];
    data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
    data[o++] = selectedVerts && selectedVerts.has(v) ? 1 : 0;
  }
  return { data, count: n };
}

/** Line segments for an object-mode wireframe overlay (no selection colouring). */
export function buildObjectWire(mesh: Mesh, color: readonly [number, number, number]): BufferData {
  return buildWire(mesh, null, color, color);
}
