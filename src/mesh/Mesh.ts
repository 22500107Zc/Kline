import { AABB, Mat4, Vec3 } from '../core/math';

/**
 * Kiln's mesh kernel.
 *
 * Master data is an n-gon polygon soup (`positions` + `faces`), which keeps
 * serialization, import/export and undo snapshots trivial. Adjacency
 * (`Topology`) is derived on demand and cached against a revision counter, so
 * operators get half-edge-quality queries without paying to maintain a
 * half-edge structure through every edit.
 */

/** An undirected edge and the faces that use it. */
export interface EdgeRec {
  a: number;
  b: number;
  /** Indices of incident faces: 1 = boundary, 2 = manifold, >2 = non-manifold. */
  faces: number[];
}

export interface Topology {
  edges: EdgeRec[];
  /** edgeOfVertPair(a, b) -> edge index */
  edgeIndex: Map<number, number>;
  /** Per face, the edge index for corner i (the edge from corner i to i+1). */
  faceEdges: number[][];
  vertEdges: number[][];
  vertFaces: number[][];
  faceNormals: Vec3[];
  faceCenters: Vec3[];
  vertNormals: Vec3[];
}

export class Mesh {
  positions: Vec3[];
  /** Polygon corner lists, CCW when viewed from the front face. */
  faces: number[][];
  /** Material slot index per face. */
  faceMaterial: number[];
  /** Per-object smooth shading flag; per-face override lives in `faceSmooth`. */
  shadeSmooth = false;
  faceSmooth: boolean[] | null = null;

  private _topology: Topology | null = null;
  private _revision = 0;

  constructor(positions: Vec3[] = [], faces: number[][] = [], faceMaterial?: number[]) {
    this.positions = positions;
    this.faces = faces;
    this.faceMaterial = faceMaterial ?? new Array(faces.length).fill(0);
  }

  get revision(): number {
    return this._revision;
  }

  get vertCount(): number {
    return this.positions.length;
  }

  get faceCount(): number {
    return this.faces.length;
  }

  get edgeCount(): number {
    return this.topology().edges.length;
  }

  get triCount(): number {
    let n = 0;
    for (const f of this.faces) n += Math.max(0, f.length - 2);
    return n;
  }

  /** Invalidate derived adjacency. Call after any structural or positional edit. */
  markDirty(): void {
    this._topology = null;
    this._revision++;
  }

  clone(): Mesh {
    const m = new Mesh(
      this.positions.map((p) => p.clone()),
      this.faces.map((f) => f.slice()),
      this.faceMaterial.slice(),
    );
    m.shadeSmooth = this.shadeSmooth;
    m.faceSmooth = this.faceSmooth ? this.faceSmooth.slice() : null;
    return m;
  }

  isFaceSmooth(f: number): boolean {
    return this.faceSmooth ? this.faceSmooth[f] : this.shadeSmooth;
  }

  setAllSmooth(smooth: boolean): void {
    this.shadeSmooth = smooth;
    this.faceSmooth = null;
    this.markDirty();
  }

  transform(m: Mat4): void {
    for (let i = 0; i < this.positions.length; i++) {
      this.positions[i] = m.transformPoint(this.positions[i]);
    }
    this.markDirty();
  }

  bounds(): AABB {
    const b = new AABB();
    for (const p of this.positions) b.expand(p);
    return b;
  }

  centroid(): Vec3 {
    if (this.positions.length === 0) return new Vec3();
    const c = new Vec3();
    for (const p of this.positions) c.addInPlace(p);
    return c.scale(1 / this.positions.length);
  }

  /** Newell's method — correct for non-planar n-gons. */
  faceNormal(f: number): Vec3 {
    const loop = this.faces[f];
    const n = new Vec3();
    for (let i = 0; i < loop.length; i++) {
      const cur = this.positions[loop[i]];
      const nxt = this.positions[loop[(i + 1) % loop.length]];
      n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
      n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
      n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    return n.normalized();
  }

  faceCenter(f: number): Vec3 {
    const loop = this.faces[f];
    const c = new Vec3();
    for (const v of loop) c.addInPlace(this.positions[v]);
    return loop.length ? c.scale(1 / loop.length) : c;
  }

  faceArea(f: number): number {
    const loop = this.faces[f];
    if (loop.length < 3) return 0;
    const a = new Vec3();
    for (let i = 0; i < loop.length; i++) {
      const cur = this.positions[loop[i]];
      const nxt = this.positions[loop[(i + 1) % loop.length]];
      a.addInPlace(cur.cross(nxt));
    }
    return a.length() * 0.5;
  }

  edgeKey(a: number, b: number): number {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return lo * (this.positions.length + 1) + hi;
  }

  topology(): Topology {
    if (this._topology) return this._topology;

    const nv = this.positions.length;
    const edges: EdgeRec[] = [];
    const edgeIndex = new Map<number, number>();
    const faceEdges: number[][] = [];
    const vertEdges: number[][] = Array.from({ length: nv }, () => []);
    const vertFaces: number[][] = Array.from({ length: nv }, () => []);

    for (let f = 0; f < this.faces.length; f++) {
      const loop = this.faces[f];
      const fe: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (a === b) {
          fe.push(-1);
          continue;
        }
        const key = this.edgeKey(a, b);
        let ei = edgeIndex.get(key);
        if (ei === undefined) {
          ei = edges.length;
          edges.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
          edgeIndex.set(key, ei);
          vertEdges[a].push(ei);
          vertEdges[b].push(ei);
        }
        edges[ei].faces.push(f);
        fe.push(ei);
      }
      faceEdges.push(fe);
      for (const v of loop) if (!vertFaces[v].includes(f)) vertFaces[v].push(f);
    }

    const faceNormals: Vec3[] = [];
    const faceCenters: Vec3[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      faceNormals.push(this.faceNormal(f));
      faceCenters.push(this.faceCenter(f));
    }

    // Area-weighted vertex normals.
    const vertNormals: Vec3[] = Array.from({ length: nv }, () => new Vec3());
    for (let f = 0; f < this.faces.length; f++) {
      const w = this.faceArea(f);
      const n = faceNormals[f].scale(w > 0 ? w : 1e-6);
      for (const v of this.faces[f]) vertNormals[v].addInPlace(n);
    }
    for (let i = 0; i < nv; i++) {
      const l = vertNormals[i].length();
      vertNormals[i] = l > 1e-9 ? vertNormals[i].scale(1 / l) : new Vec3(0, 0, 1);
    }

    this._topology = {
      edges, edgeIndex, faceEdges, vertEdges, vertFaces, faceNormals, faceCenters, vertNormals,
    };
    return this._topology;
  }

  findEdge(a: number, b: number): number {
    const t = this.topology();
    const ei = t.edgeIndex.get(this.edgeKey(a, b));
    return ei === undefined ? -1 : ei;
  }

  edgeCenter(ei: number): Vec3 {
    const e = this.topology().edges[ei];
    return this.positions[e.a].add(this.positions[e.b]).scale(0.5);
  }

  isBoundaryEdge(ei: number): boolean {
    return this.topology().edges[ei].faces.length === 1;
  }

  /** Faces sharing an edge with `f`. */
  faceNeighbors(f: number): number[] {
    const t = this.topology();
    const out: number[] = [];
    for (const ei of t.faceEdges[f]) {
      if (ei < 0) continue;
      for (const nf of t.edges[ei].faces) if (nf !== f && !out.includes(nf)) out.push(nf);
    }
    return out;
  }

  /**
   * Fan-triangulate every face. Returns triangle corner indices plus, for each
   * triangle, the face it came from (used for picking and flat shading).
   */
  triangulate(): { indices: number[]; triFace: number[] } {
    const indices: number[] = [];
    const triFace: number[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      const loop = this.faces[f];
      for (let i = 1; i + 1 < loop.length; i++) {
        indices.push(loop[0], loop[i], loop[i + 1]);
        triFace.push(f);
      }
    }
    return { indices, triFace };
  }

  /** Drop faces with fewer than 3 distinct corners and repeated corners. */
  cleanDegenerate(): void {
    const faces: number[][] = [];
    const mats: number[] = [];
    const smooth: boolean[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      const loop: number[] = [];
      const src = this.faces[f];
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (loop.length === 0 || loop[loop.length - 1] !== v) loop.push(v);
      }
      while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
      if (loop.length >= 3) {
        faces.push(loop);
        mats.push(this.faceMaterial[f] ?? 0);
        smooth.push(this.isFaceSmooth(f));
      }
    }
    this.faces = faces;
    this.faceMaterial = mats;
    if (this.faceSmooth) this.faceSmooth = smooth;
    this.markDirty();
  }

  /** Remove vertices no face references. Returns old->new index map (-1 = dropped). */
  removeLooseVertices(): number[] {
    const used = new Uint8Array(this.positions.length);
    for (const f of this.faces) for (const v of f) used[v] = 1;
    const map = new Array<number>(this.positions.length).fill(-1);
    const positions: Vec3[] = [];
    for (let i = 0; i < this.positions.length; i++) {
      if (used[i]) {
        map[i] = positions.length;
        positions.push(this.positions[i]);
      }
    }
    this.positions = positions;
    this.faces = this.faces.map((f) => f.map((v) => map[v]));
    this.markDirty();
    return map;
  }

  /** Append another mesh's geometry. Returns the vertex offset applied. */
  append(other: Mesh, materialOffset = 0): number {
    const off = this.positions.length;
    const faceOff = this.faces.length;
    for (const p of other.positions) this.positions.push(p.clone());
    for (const f of other.faces) this.faces.push(f.map((v) => v + off));
    for (const m of other.faceMaterial) this.faceMaterial.push(m + materialOffset);
    if (this.faceSmooth || other.faceSmooth) {
      const mine = this.faceSmooth ?? new Array(faceOff).fill(this.shadeSmooth);
      for (let f = 0; f < other.faces.length; f++) mine.push(other.isFaceSmooth(f));
      this.faceSmooth = mine;
    }
    this.markDirty();
    return off;
  }

  toJSON(): { positions: number[]; faces: number[][]; faceMaterial: number[]; shadeSmooth: boolean; faceSmooth: boolean[] | null } {
    const positions: number[] = [];
    for (const p of this.positions) positions.push(p.x, p.y, p.z);
    return {
      positions,
      faces: this.faces.map((f) => f.slice()),
      faceMaterial: this.faceMaterial.slice(),
      shadeSmooth: this.shadeSmooth,
      faceSmooth: this.faceSmooth ? this.faceSmooth.slice() : null,
    };
  }

  static fromJSON(d: ReturnType<Mesh['toJSON']>): Mesh {
    const positions: Vec3[] = [];
    for (let i = 0; i + 2 < d.positions.length; i += 3) {
      positions.push(new Vec3(d.positions[i], d.positions[i + 1], d.positions[i + 2]));
    }
    const m = new Mesh(positions, d.faces.map((f) => f.slice()), d.faceMaterial?.slice());
    m.shadeSmooth = !!d.shadeSmooth;
    m.faceSmooth = d.faceSmooth ? d.faceSmooth.slice() : null;
    return m;
  }
}
