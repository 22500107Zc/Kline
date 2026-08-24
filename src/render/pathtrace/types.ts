/**
 * The flat, structured-cloneable description of a scene the path tracer works
 * from. Nothing here holds a class instance, so the whole thing crosses into a
 * worker with no serialization step of its own.
 */

/** Per material: colour(3) metallic roughness emission(3) emissionStrength alpha. */
export const MATERIAL_STRIDE = 10;
/** Per light: position(3) type colour(3) radius direction(3) spotCos. */
export const LIGHT_STRIDE = 12;

export interface TraceCamera {
  origin: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  /** Vertical field of view in radians. */
  fovY: number;
  orthographic: boolean;
  orthoHeight: number;
}

export interface TraceScene {
  /** 9 floats per triangle. */
  positions: Float32Array;
  /** 9 floats per triangle; already smoothed or faceted as authored. */
  normals: Float32Array;
  /** 6 floats per triangle, or empty when the mesh has no coordinates. */
  uvs: Float32Array;
  /** One material index per triangle. */
  material: Int32Array;
  materials: Float32Array;
  lights: Float32Array;
  lightCount: number;
  background: [number, number, number];
  ambient: number;
  /** Strength of the sky as an area light, on top of the flat background. */
  skyStrength: number;
  camera: TraceCamera;
}

export interface RenderSettings {
  width: number;
  height: number;
  samples: number;
  maxBounces: number;
  /** Samples accumulated per progressive pass. */
  samplesPerPass: number;
  transparentBackground: boolean;
  /** Stops of exposure applied before tonemapping; 0 leaves it alone. */
  exposure: number;
}

export function defaultRenderSettings(): RenderSettings {
  return {
    width: 960, height: 540, samples: 128, maxBounces: 6,
    samplesPerPass: 4, transparentBackground: false, exposure: 0,
  };
}

export interface BandRequest {
  y0: number;
  y1: number;
  pass: number;
  samples: number;
  seed: number;
}

export interface BandResult {
  y0: number;
  y1: number;
  samples: number;
  /** RGB radiance sums for the band, 3 floats per pixel. */
  data: Float32Array;
}
