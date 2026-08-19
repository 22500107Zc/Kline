import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Primitive builders. Dimensions follow Blender's defaults (2m cube, 1m radius
 * sphere, Z-up) so that muscle memory and imported references line up.
 */

export function createPlane(size = 2): Mesh {
  const h = size / 2;
  return new Mesh(
    [new Vec3(-h, -h, 0), new Vec3(h, -h, 0), new Vec3(h, h, 0), new Vec3(-h, h, 0)],
    [[0, 1, 2, 3]],
  );
}

export function createGrid(size = 2, subdivisions = 10): Mesh {
  const n = Math.max(1, Math.floor(subdivisions));
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      positions.push(new Vec3((x / n - 0.5) * size, (y / n - 0.5) * size, 0));
    }
  }
  const idx = (x: number, y: number) => y * (n + 1) + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      faces.push([idx(x, y), idx(x + 1, y), idx(x + 1, y + 1), idx(x, y + 1)]);
    }
  }
  return new Mesh(positions, faces);
}

export function createCube(size = 2): Mesh {
  const h = size / 2;
  const positions = [
    new Vec3(-h, -h, -h), new Vec3(h, -h, -h), new Vec3(h, h, -h), new Vec3(-h, h, -h),
    new Vec3(-h, -h, h), new Vec3(h, -h, h), new Vec3(h, h, h), new Vec3(-h, h, h),
  ];
  const faces = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [1, 2, 6, 5], // +X
    [2, 3, 7, 6], // +Y
    [3, 0, 4, 7], // -X
  ];
  return new Mesh(positions, faces);
}

export function createUVSphere(radius = 1, segments = 32, rings = 16): Mesh {
  const seg = Math.max(3, Math.floor(segments));
  const rng = Math.max(2, Math.floor(rings));
  const positions: Vec3[] = [];
  const faces: number[][] = [];

  positions.push(new Vec3(0, 0, radius));
  for (let r = 1; r < rng; r++) {
    const phi = (r / rng) * Math.PI;
    const z = Math.cos(phi) * radius;
    const rad = Math.sin(phi) * radius;
    for (let s = 0; s < seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      positions.push(new Vec3(Math.cos(th) * rad, Math.sin(th) * rad, z));
    }
  }
  positions.push(new Vec3(0, 0, -radius));

  const ringStart = (r: number) => 1 + (r - 1) * seg;
  const bottom = positions.length - 1;

  for (let s = 0; s < seg; s++) {
    const a = ringStart(1) + s;
    const b = ringStart(1) + ((s + 1) % seg);
    faces.push([0, a, b]);
  }
  for (let r = 1; r < rng - 1; r++) {
    for (let s = 0; s < seg; s++) {
      const a = ringStart(r) + s;
      const b = ringStart(r) + ((s + 1) % seg);
      const c = ringStart(r + 1) + ((s + 1) % seg);
      const d = ringStart(r + 1) + s;
      faces.push([a, d, c, b]);
    }
  }
  for (let s = 0; s < seg; s++) {
    const a = ringStart(rng - 1) + s;
    const b = ringStart(rng - 1) + ((s + 1) % seg);
    faces.push([bottom, b, a]);
  }

  const m = new Mesh(positions, faces);
  m.setAllSmooth(true);
  return m;
}

export function createIcoSphere(radius = 1, subdivisions = 2): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let positions = [
    new Vec3(-1, t, 0), new Vec3(1, t, 0), new Vec3(-1, -t, 0), new Vec3(1, -t, 0),
    new Vec3(0, -1, t), new Vec3(0, 1, t), new Vec3(0, -1, -t), new Vec3(0, 1, -t),
    new Vec3(t, 0, -1), new Vec3(t, 0, 1), new Vec3(-t, 0, -1), new Vec3(-t, 0, 1),
  ].map((p) => p.normalized());
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < Math.max(0, Math.floor(subdivisions)); s++) {
    const midCache = new Map<number, number>();
    const next: number[][] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const p = positions[a].add(positions[b]).scale(0.5).normalized();
      const i = positions.length;
      positions.push(p);
      midCache.set(key, i);
      return i;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  const m = new Mesh(positions.map((p) => p.scale(radius)), faces);
  m.setAllSmooth(true);
  return m;
}

export function createCylinder(radius = 1, depth = 2, segments = 32, capped = true): Mesh {
  const seg = Math.max(3, Math.floor(segments));
  const h = depth / 2;
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  for (let s = 0; s < seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    positions.push(new Vec3(Math.cos(th) * radius, Math.sin(th) * radius, -h));
  }
  for (let s = 0; s < seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    positions.push(new Vec3(Math.cos(th) * radius, Math.sin(th) * radius, h));
  }
  for (let s = 0; s < seg; s++) {
    const a = s;
    const b = (s + 1) % seg;
    faces.push([a, b, b + seg, a + seg]);
  }
  if (capped) {
    const bottom: number[] = [];
    const top: number[] = [];
    for (let s = seg - 1; s >= 0; s--) bottom.push(s);
    for (let s = 0; s < seg; s++) top.push(s + seg);
    faces.push(bottom, top);
  }
  return new Mesh(positions, faces);
}

export function createCone(radius = 1, depth = 2, segments = 32): Mesh {
  const seg = Math.max(3, Math.floor(segments));
  const h = depth / 2;
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  for (let s = 0; s < seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    positions.push(new Vec3(Math.cos(th) * radius, Math.sin(th) * radius, -h));
  }
  const apex = positions.length;
  positions.push(new Vec3(0, 0, h));
  for (let s = 0; s < seg; s++) faces.push([s, (s + 1) % seg, apex]);
  const bottom: number[] = [];
  for (let s = seg - 1; s >= 0; s--) bottom.push(s);
  faces.push(bottom);
  return new Mesh(positions, faces);
}

export function createTorus(major = 1, minor = 0.25, majorSeg = 32, minorSeg = 16): Mesh {
  const M = Math.max(3, Math.floor(majorSeg));
  const N = Math.max(3, Math.floor(minorSeg));
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < M; i++) {
    const u = (i / M) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let j = 0; j < N; j++) {
      const v = (j / N) * Math.PI * 2;
      const r = major + minor * Math.cos(v);
      positions.push(new Vec3(cu * r, su * r, minor * Math.sin(v)));
    }
  }
  const idx = (i: number, j: number) => (i % M) * N + (j % N);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
    }
  }
  const m = new Mesh(positions, faces);
  m.setAllSmooth(true);
  return m;
}

export function createCircle(radius = 1, segments = 32, fill = true): Mesh {
  const seg = Math.max(3, Math.floor(segments));
  const positions: Vec3[] = [];
  for (let s = 0; s < seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    positions.push(new Vec3(Math.cos(th) * radius, Math.sin(th) * radius, 0));
  }
  const faces: number[][] = [];
  if (fill) faces.push(positions.map((_, i) => i));
  return new Mesh(positions, faces);
}

export type PrimitiveKind =
  | 'plane' | 'cube' | 'uvsphere' | 'icosphere' | 'cylinder' | 'cone' | 'torus' | 'grid' | 'circle';

export const PRIMITIVES: { kind: PrimitiveKind; label: string; build: () => Mesh }[] = [
  { kind: 'plane', label: 'Plane', build: () => createPlane() },
  { kind: 'cube', label: 'Cube', build: () => createCube() },
  { kind: 'circle', label: 'Circle', build: () => createCircle() },
  { kind: 'uvsphere', label: 'UV Sphere', build: () => createUVSphere() },
  { kind: 'icosphere', label: 'Ico Sphere', build: () => createIcoSphere() },
  { kind: 'cylinder', label: 'Cylinder', build: () => createCylinder() },
  { kind: 'cone', label: 'Cone', build: () => createCone() },
  { kind: 'torus', label: 'Torus', build: () => createTorus() },
  { kind: 'grid', label: 'Grid', build: () => createGrid() },
];

export function buildPrimitive(kind: PrimitiveKind): Mesh {
  const entry = PRIMITIVES.find((p) => p.kind === kind);
  return entry ? entry.build() : createCube();
}
