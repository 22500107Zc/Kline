import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Scene } from '../scene/Scene';

/**
 * Wavefront OBJ. Kline is Z-up like Blender, while OBJ is conventionally Y-up,
 * so both directions convert axes the way Blender's default importer/exporter
 * does: (x, y, z)_kline <-> (x, z, -y)_obj.
 */

function toObjAxes(p: Vec3): Vec3 {
  return new Vec3(p.x, p.z, -p.y);
}

function fromObjAxes(p: Vec3): Vec3 {
  return new Vec3(p.x, -p.z, p.y);
}

export function exportOBJ(scene: Scene, selectionOnly = false): string {
  const lines: string[] = ['# Exported from Kline', `# ${new Date().toISOString()}`];
  const matLines: string[] = [];
  let vertexOffset = 1;
  let uvOffset = 1;
  const seenMaterials = new Set<number>();

  for (const obj of scene.objects.values()) {
    if (obj.type !== 'mesh' || !obj.mesh) continue;
    if (selectionOnly && !scene.selection.has(obj.id)) continue;
    const mesh = obj.evaluated();
    if (!mesh) continue;
    const model = obj.worldMatrix(scene);
    const normalMat = model.normalMatrix();
    const t = mesh.topology();

    lines.push(`o ${obj.name.replace(/\s+/g, '_')}`);
    for (const p of mesh.positions) {
      const w = toObjAxes(model.transformPoint(p));
      lines.push(`v ${w.x.toFixed(6)} ${w.y.toFixed(6)} ${w.z.toFixed(6)}`);
    }
    for (const n of t.vertNormals) {
      const w = toObjAxes(normalMat.transformDirection(n)).normalized();
      lines.push(`vn ${w.x.toFixed(6)} ${w.y.toFixed(6)} ${w.z.toFixed(6)}`);
    }
    // Texture coordinates are per corner, so they get their own index space.
    const uvIndex: number[][] = [];
    let uvCount = 0;
    for (let f = 0; f < mesh.faces.length; f++) {
      const uv = mesh.uvFor(f);
      if (!uv) {
        uvIndex.push([]);
        continue;
      }
      const row: number[] = [];
      for (let i = 0; i < mesh.faces[f].length; i++) {
        lines.push(`vt ${uv[i * 2].toFixed(6)} ${uv[i * 2 + 1].toFixed(6)}`);
        row.push(uvOffset + uvCount);
        uvCount++;
      }
      uvIndex.push(row);
    }

    let lastSlot = -1;
    for (let f = 0; f < mesh.faces.length; f++) {
      const slot = mesh.faceMaterial[f] ?? 0;
      if (slot !== lastSlot) {
        const matIndex = obj.materialSlots[slot] ?? 0;
        const mat = scene.materials[matIndex];
        if (mat) {
          const safe = mat.name.replace(/\s+/g, '_');
          lines.push(`usemtl ${safe}`);
          if (!seenMaterials.has(matIndex)) {
            seenMaterials.add(matIndex);
            matLines.push(
              `newmtl ${safe}`,
              `Kd ${mat.color.map((c) => c.toFixed(6)).join(' ')}`,
              `Ke ${mat.emission.map((c) => (c * mat.emissionStrength).toFixed(6)).join(' ')}`,
              `Pm ${mat.metallic.toFixed(4)}`,
              `Pr ${mat.roughness.toFixed(4)}`,
              `d ${mat.alpha.toFixed(4)}`,
              '',
            );
          }
        }
        lastSlot = slot;
      }
      lines.push(`s ${mesh.isFaceSmooth(f) ? 1 : 'off'}`);
      const uvRow = uvIndex[f];
      const corners = mesh.faces[f].map((v, i) => (
        uvRow.length
          ? `${v + vertexOffset}/${uvRow[i]}/${v + vertexOffset}`
          : `${v + vertexOffset}//${v + vertexOffset}`
      ));
      lines.push(`f ${corners.join(' ')}`);
    }
    vertexOffset += mesh.positions.length;
    uvOffset += uvCount;
  }
  return lines.join('\n') + '\n';
}

export function exportMTL(scene: Scene): string {
  const out: string[] = ['# Exported from Kline'];
  for (const mat of scene.materials) {
    out.push(
      `newmtl ${mat.name.replace(/\s+/g, '_')}`,
      `Kd ${mat.color.map((c) => c.toFixed(6)).join(' ')}`,
      `Ke ${mat.emission.map((c) => (c * mat.emissionStrength).toFixed(6)).join(' ')}`,
      `Pm ${mat.metallic.toFixed(4)}`,
      `Pr ${mat.roughness.toFixed(4)}`,
      `d ${mat.alpha.toFixed(4)}`,
      '',
    );
  }
  return out.join('\n');
}

export interface ImportedObject {
  name: string;
  mesh: Mesh;
}

/** A coordinate that is missing, misspelt or overflowed reads as zero. */
function num(text: string | undefined): number {
  const v = Number(text);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Parse an OBJ file into one mesh per `o`/`g` group.
 *
 * OBJ is a text format that arrives from everywhere — other applications,
 * half-finished exports, files truncated by a failed download — so this parser
 * treats every line as a suggestion. Nothing it returns can contain a
 * non-finite coordinate or an index that does not name a vertex.
 */
export function importOBJ(text: string): ImportedObject[] {
  const positions: Vec3[] = [];
  const objects: ImportedObject[] = [];
  let current: { name: string; faces: number[][]; smooth: boolean[] } | null = null;

  const flush = (): void => {
    if (!current || current.faces.length === 0) return;
    // Re-index so each object only carries the vertices it uses. Every corner
    // here has already been checked against the vertex table, so the lookup
    // cannot miss.
    const map = new Map<number, number>();
    const localPositions: Vec3[] = [];
    const faces = current.faces.map((f) =>
      f.map((v) => {
        let idx = map.get(v);
        if (idx === undefined) {
          idx = localPositions.length;
          map.set(v, idx);
          localPositions.push(positions[v]);
        }
        return idx;
      }),
    );
    const mesh = new Mesh(localPositions, faces);
    mesh.faceSmooth = current.smooth.slice();
    mesh.shadeSmooth = current.smooth.some(Boolean);
    mesh.cleanDegenerate();
    // A group whose faces were all degenerate or all unindexable leaves nothing
    // to show; an empty entry in the outliner is worse than no entry.
    if (mesh.faces.length) objects.push({ name: current.name, mesh });
  };

  let smooth = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      // A vertex line always produces a vertex, even when its numbers are
      // unreadable: face indices count `v` lines, so skipping one would shift
      // every index after it and quietly rebuild the model wrong. A bad
      // component becomes zero instead, which is visible and local.
      positions.push(fromObjAxes(new Vec3(num(parts[1]), num(parts[2]), num(parts[3]))));
    } else if (tag === 'o' || tag === 'g') {
      flush();
      current = { name: parts.slice(1).join(' ') || 'Object', faces: [], smooth: [] };
    } else if (tag === 's') {
      smooth = parts[1] !== 'off' && parts[1] !== '0';
    } else if (tag === 'f') {
      if (!current) current = { name: 'Object', faces: [], smooth: [] };
      const loop: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const spec = parts[i].split('/')[0];
        let idx = parseInt(spec, 10);
        if (Number.isNaN(idx)) continue;
        // Negative indices count back from the vertices seen so far, positive
        // ones are 1-based from the top of the file. Either way the result has
        // to name a vertex that exists: OBJ requires vertices before the faces
        // that use them, so anything else is a corrupt or truncated file, and
        // the corner is dropped rather than pointed at an invented origin.
        if (idx < 0) idx = positions.length + idx;
        else idx -= 1;
        if (idx < 0 || idx >= positions.length) continue;
        loop.push(idx);
      }
      if (loop.length >= 3) {
        current.faces.push(loop);
        current.smooth.push(smooth);
      }
    }
  }
  flush();
  return objects;
}

/** Bake an object's world transform into its geometry (used on import/export). */
export function applyTransformToMesh(mesh: Mesh, m: Mat4): Mesh {
  const out = mesh.clone();
  out.transform(m);
  return out;
}
