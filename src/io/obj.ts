import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Scene } from '../scene/Scene';

/**
 * Wavefront OBJ. Kiln is Z-up like Blender, while OBJ is conventionally Y-up,
 * so both directions convert axes the way Blender's default importer/exporter
 * does: (x, y, z)_kiln <-> (x, z, -y)_obj.
 */

function toObjAxes(p: Vec3): Vec3 {
  return new Vec3(p.x, p.z, -p.y);
}

function fromObjAxes(p: Vec3): Vec3 {
  return new Vec3(p.x, -p.z, p.y);
}

export function exportOBJ(scene: Scene, selectionOnly = false): string {
  const lines: string[] = ['# Exported from Kiln', `# ${new Date().toISOString()}`];
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
  const out: string[] = ['# Exported from Kiln'];
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

/** Parse an OBJ file into one mesh per `o`/`g` group. */
export function importOBJ(text: string): ImportedObject[] {
  const positions: Vec3[] = [];
  const objects: ImportedObject[] = [];
  let current: { name: string; faces: number[][]; smooth: boolean[] } | null = null;

  const flush = (): void => {
    if (!current || current.faces.length === 0) return;
    // Re-index so each object only carries the vertices it uses.
    const map = new Map<number, number>();
    const localPositions: Vec3[] = [];
    const faces = current.faces.map((f) =>
      f.map((v) => {
        let idx = map.get(v);
        if (idx === undefined) {
          idx = localPositions.length;
          map.set(v, idx);
          localPositions.push(positions[v] ?? new Vec3());
        }
        return idx;
      }),
    );
    const mesh = new Mesh(localPositions, faces);
    mesh.faceSmooth = current.smooth.slice();
    mesh.shadeSmooth = current.smooth.some(Boolean);
    mesh.cleanDegenerate();
    objects.push({ name: current.name, mesh });
  };

  let smooth = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      positions.push(fromObjAxes(new Vec3(+parts[1], +parts[2], +parts[3])));
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
        if (idx < 0) idx = positions.length + idx;
        else idx -= 1;
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
