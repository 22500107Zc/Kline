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
  /**
   * Texture coordinates, stored per face corner as a flat [u0,v0,u1,v1,…] run.
   * A face with no coordinates holds null. Corner storage rather than per
   * vertex is what lets a seam carry two different UVs at the same point.
   */
  faceUV: (number[] | null)[] | null = null;
  /**
   * UV seams, keyed by vertex pair. Unwrapping cuts the surface along these.
   * Keyed by index pair rather than edge index because edge indices are
   * derived and renumber on every topology change.
   */
  seams: Set<string> | null = null;
  /**
   * Per-edge bevel weight in 0..1, keyed the same way as seams. A bevel
   * multiplies its width by this, so one operation can round a model's hard
   * corners heavily and its softer ones barely. Absent means 1.
   */
  edgeWeights: Map<string, number> | null = null;

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
    if (this.faceUV) {
      // Operators append and trim faces freely; keep the parallel array the
      // same length so indices never drift, and drop coordinates for any face
      // whose corner count no longer matches.
      while (this.faceUV.length < this.faces.length) this.faceUV.push(null);
      if (this.faceUV.length > this.faces.length) this.faceUV.length = this.faces.length;
      for (let f = 0; f < this.faces.length; f++) {
        const uv = this.faceUV[f];
        if (uv && uv.length !== this.faces[f].length * 2) this.faceUV[f] = null;
      }
    }
  }

  get hasUV(): boolean {
    if (!this.faceUV) return false;
    for (const uv of this.faceUV) if (uv) return true;
    return false;
  }

  /** Corner coordinates for a face, or null when it has none. */
  uvFor(f: number): number[] | null {
    const uv = this.faceUV?.[f];
    return uv && uv.length === this.faces[f].length * 2 ? uv : null;
  }

  setUV(f: number, uv: number[] | null): void {
    if (!this.faceUV) {
      if (uv === null) return;
      this.faceUV = new Array(this.faces.length).fill(null);
    }
    while (this.faceUV.length <= f) this.faceUV.push(null);
    this.faceUV[f] = uv;
  }

  /** Coordinates at one corner of a face, or null when it has none. */
  uvAt(f: number, corner: number): [number, number] | null {
    const uv = this.uvFor(f);
    return uv ? [uv[corner * 2], uv[corner * 2 + 1]] : null;
  }

  clearUV(): void {
    this.faceUV = null;
    this.markDirty();
  }

  static seamKey(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  isSeam(a: number, b: number): boolean {
    return this.seams ? this.seams.has(Mesh.seamKey(a, b)) : false;
  }

  /** Bevel weight for an edge; 1 when none has been set. */
  bevelWeight(a: number, b: number): number {
    if (!this.edgeWeights) return 1;
    return this.edgeWeights.get(Mesh.seamKey(a, b)) ?? 1;
  }

  setBevelWeight(a: number, b: number, w: number): void {
    const k = Mesh.seamKey(a, b);
    if (w >= 1) {
      this.edgeWeights?.delete(k);
      return;
    }
    if (!this.edgeWeights) this.edgeWeights = new Map();
    this.edgeWeights.set(k, Math.max(0, w));
  }

  setSeam(a: number, b: number, on: boolean): void {
    if (!this.seams) {
      if (!on) return;
      this.seams = new Set();
    }
    const k = Mesh.seamKey(a, b);
    if (on) this.seams.add(k);
    else this.seams.delete(k);
  }

  clone(): Mesh {
    const m = new Mesh(
      this.positions.map((p) => p.clone()),
      this.faces.map((f) => f.slice()),
      this.faceMaterial.slice(),
    );
    m.shadeSmooth = this.shadeSmooth;
    m.faceSmooth = this.faceSmooth ? this.faceSmooth.slice() : null;
    m.faceUV = this.faceUV ? this.faceUV.map((u) => (u ? u.slice() : null)) : null;
    m.seams = this.seams ? new Set(this.seams) : null;
    m.edgeWeights = this.edgeWeights ? new Map(this.edgeWeights) : null;
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
    const uvs: (number[] | null)[] = [];
    for (let f = 0; f < this.faces.length; f++) {
      const loop: number[] = [];
      const src = this.faces[f];
      const srcUV = this.uvFor(f);
      const uv: number[] = [];
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (loop.length === 0 || loop[loop.length - 1] !== v) {
          loop.push(v);
          if (srcUV) uv.push(srcUV[i * 2], srcUV[i * 2 + 1]);
        }
      }
      while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
        loop.pop();
        uv.length = Math.max(0, uv.length - 2);
      }
      if (loop.length >= 3) {
        faces.push(loop);
        mats.push(this.faceMaterial[f] ?? 0);
        smooth.push(this.isFaceSmooth(f));
        uvs.push(srcUV && uv.length === loop.length * 2 ? uv : null);
      }
    }
    this.faces = faces;
    this.faceMaterial = mats;
    if (this.faceSmooth) this.faceSmooth = smooth;
    if (this.faceUV) this.faceUV = uvs;
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
    if (this.faceUV || other.faceUV) {
      const mine = this.faceUV ?? new Array(faceOff).fill(null);
      for (let f = 0; f < other.faces.length; f++) {
        const uv = other.uvFor(f);
        mine.push(uv ? uv.slice() : null);
      }
      this.faceUV = mine;
    }
    this.markDirty();
    return off;
  }

  toJSON(): {
    positions: number[]; faces: number[][]; faceMaterial: number[];
    shadeSmooth: boolean; faceSmooth: boolean[] | null;
    faceUV?: (number[] | null)[] | null; seams?: string[] | null;
    edgeWeights?: [string, number][] | null;
  } {
    const positions: number[] = [];
    for (const p of this.positions) positions.push(p.x, p.y, p.z);
    return {
      positions,
      faces: this.faces.map((f) => f.slice()),
      faceMaterial: this.faceMaterial.slice(),
      shadeSmooth: this.shadeSmooth,
      faceSmooth: this.faceSmooth ? this.faceSmooth.slice() : null,
      faceUV: this.faceUV ? this.faceUV.map((u) => (u ? u.slice() : null)) : null,
      seams: this.seams ? [...this.seams] : null,
      edgeWeights: this.edgeWeights ? [...this.edgeWeights] : null,
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
    m.faceUV = d.faceUV ? d.faceUV.map((u) => (u ? u.slice() : null)) : null;
    m.seams = d.seams && d.seams.length ? new Set(d.seams) : null;
    m.edgeWeights = d.edgeWeights && d.edgeWeights.length ? new Map(d.edgeWeights) : null;
    return m;
  }
}
