export interface Material {
  name: string;
  /** Linear base colour, 0..1 per channel. */
  color: [number, number, number];
  metallic: number;
  roughness: number;
  emission: [number, number, number];
  emissionStrength: number;
  /** 0 = fully transparent, 1 = opaque. Alpha-blended in the viewport. */
  alpha: number;
  /** Scene texture id multiplied into the base colour, or null for a flat colour. */
  baseColorTexture: number | null;
  /** Tiling and offset applied to the mesh's coordinates before sampling. */
  uvScale: [number, number];
  uvOffset: [number, number];
}

let materialCounter = 0;

export function createMaterial(partial: Partial<Material> = {}): Material {
  materialCounter++;
  return {
    name: partial.name ?? `Material.${String(materialCounter).padStart(3, '0')}`,
    color: partial.color ?? [0.8, 0.8, 0.8],
    metallic: partial.metallic ?? 0,
    roughness: partial.roughness ?? 0.5,
    emission: partial.emission ?? [0, 0, 0],
    emissionStrength: partial.emissionStrength ?? 0,
    alpha: partial.alpha ?? 1,
    baseColorTexture: partial.baseColorTexture ?? null,
    uvScale: partial.uvScale ?? [1, 1],
    uvOffset: partial.uvOffset ?? [0, 0],
  };
}

export function cloneMaterial(m: Material): Material {
  return {
    ...m,
    color: [...m.color] as [number, number, number],
    emission: [...m.emission] as [number, number, number],
    uvScale: [...m.uvScale] as [number, number],
    uvOffset: [...m.uvOffset] as [number, number],
  };
}

/** sRGB hex string ("#rrggbb") to linear float triple. */
export function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))) as
    [number, number, number];
}

/** Linear float triple to an sRGB hex string. */
export function linearToHex(c: readonly [number, number, number]): string {
  const to8 = (v: number) => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255);
  };
  return `#${c.map((v) => to8(v).toString(16).padStart(2, '0')).join('')}`;
}
