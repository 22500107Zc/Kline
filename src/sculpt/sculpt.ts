import { Vec3, clamp } from '../core/math';
import { Mesh } from '../mesh/Mesh';

/**
 * Sculpting.
 *
 * A stroke is a series of dabs. Each dab gathers the vertices inside the brush
 * sphere from a hash grid, weights them by a falloff curve and displaces them.
 * The grid is rebuilt only when the vertex count changes, not on every dab —
 * positions move but they never move far enough in one dab to leave their
 * cell, and the gather already reads a one-cell margin.
 */

export type SculptBrush =
  | 'draw' | 'smooth' | 'inflate' | 'grab' | 'flatten' | 'scrape' | 'pinch' | 'crease' | 'mask';

export const BRUSH_LABELS: Record<SculptBrush, string> = {
  draw: 'Draw',
  smooth: 'Smooth',
  inflate: 'Inflate',
  grab: 'Grab',
  flatten: 'Flatten',
  scrape: 'Scrape',
  pinch: 'Pinch',
  crease: 'Crease',
  mask: 'Mask',
};

export interface SculptSettings {
  brush: SculptBrush;
  /** Brush radius in world units. */
  radius: number;
  /** 0..1. */
  strength: number;
  /** Hold Ctrl: draw digs in, inflate deflates, flatten becomes scrape. */
  invert: boolean;
  symmetry: [boolean, boolean, boolean];
  /** Blend a little smoothing into every dab. */
  autoSmooth: number;
  /**
   * Distance between dabs, as a fraction of the radius.
   *
   * Without this a stroke is one dab per pointer event, so the same gesture
   * carves a deep trench when drawn slowly and a dotted line when drawn fast —
   * the result depends on the mouse's report rate rather than on the stroke.
   * Stepping along the path at a fixed spacing makes the two identical.
   */
  spacing: number;
}

export function defaultSculpt(): SculptSettings {
  return {
    brush: 'draw', radius: 0.35, strength: 0.5, invert: false,
    symmetry: [false, false, false], autoSmooth: 0.1, spacing: 0.2,
  };
}

/** Uniform hash grid over the vertices, for brush-radius queries. */
export class VertexGrid {
  private cells = new Map<number, number[]>();
  private cell: number;
  private vertCount: number;

  constructor(private mesh: Mesh, cellSize: number) {
    this.cell = Math.max(cellSize, 1e-5);
    this.vertCount = mesh.positions.length;
    this.rebuild();
  }

  private hash(x: number, y: number, z: number): number {
    // Three large primes; collisions just mean a slightly longer bucket scan.
    return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  }

  private rebuild(): void {
    this.cells.clear();
    const c = this.cell;
    for (let i = 0; i < this.mesh.positions.length; i++) {
      const p = this.mesh.positions[i];
      const k = this.hash(Math.floor(p.x / c), Math.floor(p.y / c), Math.floor(p.z / c));
      const b = this.cells.get(k);
      if (b) b.push(i);
      else this.cells.set(k, [i]);
    }
    this.vertCount = this.mesh.positions.length;
  }

  /** Rebuild if the mesh changed shape under us. */
  refresh(): void {
    if (this.mesh.positions.length !== this.vertCount) this.rebuild();
  }

  query(center: Vec3, radius: number): number[] {
    const c = this.cell;
    const r = Math.ceil(radius / c);
    const cx = Math.floor(center.x / c);
    const cy = Math.floor(center.y / c);
    const cz = Math.floor(center.z / c);
    const out: number[] = [];
    const r2 = radius * radius;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const bucket = this.cells.get(this.hash(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const i of bucket) {
            if (this.mesh.positions[i].sub(center).lengthSq() <= r2) out.push(i);
          }
        }
      }
    }
    return out;
  }
}

/** Standard sculpt falloff: 1 at the centre, 0 with a flat tangent at the rim. */
export function brushFalloff(t: number): number {
  const x = clamp(t, 0, 1);
  const i = 1 - x * x;
  return i * i * i;
}

interface Grabbed {
  index: number;
  original: Vec3;
  weight: number;
  /** Sign per axis, so mirrored vertices drag in the mirrored direction. */
  mirror: [number, number, number];
}

/**
 * One continuous stroke. Everything is in the mesh's own space; the caller
 * converts from world.
 */
export class SculptStroke {
  private grid: VertexGrid;
  private grabbed: Grabbed[] | null = null;
  /** Where the last dab landed, so spacing is measured along the path. */
  private lastDab: Vec3 | null = null;
  /** Vertices this stroke has moved, for the caller's dirty tracking. */
  readonly touched = new Set<number>();

  constructor(private mesh: Mesh, private settings: SculptSettings, localRadius: number) {
    this.grid = new VertexGrid(mesh, Math.max(localRadius * 0.5, 1e-4));
  }

  /** Capture the vertices a grab stroke will drag. */
  begin(center: Vec3, radius: number): void {
    // Anchor the path where the stroke was pressed, not wherever the first
    // pointer report happens to land — otherwise a fast drag starts its dabs
    // partway along and a slow one does not.
    this.lastDab = center.clone();
    if (this.settings.brush !== 'grab') return;
    this.grabbed = [];
    const claimed = new Set<number>();
    for (const copy of this.mirrored(center, new Vec3(0, 0, 1))) {
      for (const i of this.grid.query(copy.center, radius)) {
        if (claimed.has(i)) continue;
        const d = this.mesh.positions[i].distanceTo(copy.center);
        const w = brushFalloff(d / radius);
        if (w <= 0) continue;
        claimed.add(i);
        this.grabbed.push({
          index: i, original: this.mesh.positions[i].clone(), weight: w, mirror: copy.mirror,
        });
      }
    }
  }

  /** Every mirrored copy of the brush, including the original. */
  private mirrored(center: Vec3, normal: Vec3): BrushCopy[] {
    let out: BrushCopy[] = [{ center: center.clone(), normal: normal.clone(), mirror: [1, 1, 1] }];
    const sym = this.settings.symmetry;
    for (let axis = 0; axis < 3; axis++) {
      if (!sym[axis]) continue;
      const add: BrushCopy[] = [];
      for (const c of out) {
        const center2 = c.center.clone();
        const normal2 = c.normal.clone();
        const mirror: [number, number, number] = [...c.mirror] as [number, number, number];
        mirror[axis] = -mirror[axis];
        if (axis === 0) { center2.x = -center2.x; normal2.x = -normal2.x; }
        if (axis === 1) { center2.y = -center2.y; normal2.y = -normal2.y; }
        if (axis === 2) { center2.z = -center2.z; normal2.z = -normal2.z; }
        add.push({ center: center2, normal: normal2, mirror });
      }
      out = out.concat(add);
    }
    return out;
  }

  /**
   * Continue the stroke to a new point, laying down as many dabs as the
   * distance covered calls for.
   *
   * The caller reports pointer positions, which arrive at whatever rate the
   * device and the frame budget allow. Walking the gap in fixed steps is what
   * makes a stroke depend on the gesture rather than on how fast it was drawn
   * or how busy the machine was at the time.
   */
  stroke(center: Vec3, normal: Vec3, radius: number, delta: Vec3): number {
    // Grab drags a captured set to an absolute offset; stepping along the path
    // would apply it repeatedly.
    if (this.settings.brush === 'grab') return this.dab(center, normal, radius, delta);

    const step = Math.max(1e-4, this.settings.spacing * radius);
    const last = this.lastDab;
    if (!last) {
      this.lastDab = center.clone();
      return this.dab(center, normal, radius, delta);
    }

    const travel = center.sub(last);
    const dist = travel.length();
    if (dist < step) return 0;

    let moved = 0;
    const steps = Math.min(64, Math.floor(dist / step));
    for (let i = 1; i <= steps; i++) {
      const at = last.add(travel.scale((i * step) / dist));
      moved += this.dab(at, normal, radius, delta);
    }
    this.lastDab = last.add(travel.scale((steps * step) / dist));
    return moved;
  }

  /**
   * Apply one dab. `delta` is the total local-space drag since `begin`, used
   * only by the grab brush. Returns how many vertices moved.
   */
  dab(center: Vec3, normal: Vec3, radius: number, delta: Vec3): number {
    this.grid.refresh();
    const s = this.settings;
    let moved = 0;

    if (s.brush === 'grab') {
      if (!this.grabbed) return 0;
      for (const g of this.grabbed) {
        const d = new Vec3(delta.x * g.mirror[0], delta.y * g.mirror[1], delta.z * g.mirror[2]);
        this.mesh.positions[g.index] = g.original.add(d.scale(g.weight));
        this.touched.add(g.index);
        moved++;
      }
      this.mesh.markDirty();
      return moved;
    }

    for (const copy of this.mirrored(center, normal)) {
      moved += this.dabAt(copy.center, copy.normal, radius, s);
    }
    if (moved) this.mesh.markDirty();
    return moved;
  }

  private dabAt(center: Vec3, normal: Vec3, radius: number, s: SculptSettings): number {
    const verts = this.grid.query(center, radius);
    if (verts.length === 0) return 0;

    // The mask brush paints the mask rather than the surface.
    if (s.brush === 'mask') {
      const mask = this.mesh.ensureMask();
      const sign = s.invert ? -1 : 1;
      let n = 0;
      for (const i of verts) {
        const w = brushFalloff(this.mesh.positions[i].distanceTo(center) / radius);
        if (w <= 0) continue;
        mask[i] = clamp(mask[i] + sign * s.strength * w * 0.5, 0, 1);
        n++;
      }
      return n;
    }

    const t = this.mesh.topology();
    const sign = s.invert ? -1 : 1;
    const amount = s.strength * radius * 0.25;

    // Brushes that reference the local surface need its average plane first.
    let planePoint = center;
    if (s.brush === 'flatten' || s.brush === 'scrape') {
      const c = new Vec3();
      for (const i of verts) c.addInPlace(this.mesh.positions[i]);
      planePoint = c.scale(1 / verts.length);
    }

    const updates: [number, Vec3][] = [];
    for (const i of verts) {
      const p = this.mesh.positions[i];
      const d = p.distanceTo(center);
      // A masked vertex is held in place, in proportion to how masked it is.
      const w = brushFalloff(d / radius) * (1 - this.mesh.maskAt(i));
      if (w <= 0) continue;
      let target = p;
      switch (s.brush) {
        case 'draw':
          target = p.add(normal.scale(sign * amount * w));
          break;
        case 'inflate':
          target = p.add((t.vertNormals[i] ?? normal).scale(sign * amount * w));
          break;
        case 'smooth': {
          target = p.lerp(this.neighbourAverage(i), clamp(s.strength * w, 0, 1));
          break;
        }
        case 'flatten': {
          const off = p.sub(planePoint).dot(normal);
          target = p.sub(normal.scale(off * clamp(s.strength * w, 0, 1) * sign));
          break;
        }
        case 'scrape': {
          const off = p.sub(planePoint).dot(normal);
          // Only pull the high side down, which is what carves a flat facet.
          if (off * sign > 0) target = p.sub(normal.scale(off * clamp(s.strength * w, 0, 1) * sign));
          break;
        }
        case 'pinch': {
          const toCentre = center.sub(p);
          const flat = toCentre.sub(normal.scale(toCentre.dot(normal)));
          target = p.add(flat.scale(clamp(s.strength * w * 0.5, 0, 1) * sign));
          break;
        }
        case 'crease': {
          const toCentre = center.sub(p);
          const flat = toCentre.sub(normal.scale(toCentre.dot(normal)));
          target = p.add(flat.scale(clamp(s.strength * w * 0.5, 0, 1)))
            .add(normal.scale(-sign * amount * w));
          break;
        }
        case 'grab':
          break;
      }
      if (s.autoSmooth > 0 && s.brush !== 'smooth') {
        target = target.lerp(this.neighbourAverage(i), s.autoSmooth * w * 0.5);
      }
      updates.push([i, target]);
    }
    for (const [i, p] of updates) {
      this.mesh.positions[i] = p;
      this.touched.add(i);
    }
    return updates.length;
  }

  private neighbourAverage(i: number): Vec3 {
    const t = this.mesh.topology();
    const edges = t.vertEdges[i] ?? [];
    if (edges.length === 0) return this.mesh.positions[i];
    const sum = new Vec3();
    for (const ei of edges) {
      const e = t.edges[ei];
      sum.addInPlace(this.mesh.positions[e.a === i ? e.b : e.a]);
    }
    return sum.scale(1 / edges.length);
  }
}

interface BrushCopy {
  center: Vec3;
  normal: Vec3;
  mirror: [number, number, number];
}
