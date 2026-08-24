/**
 * Edge-aware denoising.
 *
 * A path tracer's noise falls off as the square root of the sample count, so
 * halving it costs four times the render. Below a few hundred samples that
 * trade is bad: the image is already telling you what the light does, and what
 * you are paying for is the last of the speckle.
 *
 * This is an à-trous wavelet filter — a blur applied several times with a
 * doubling stride, so a handful of passes reach as wide as a large kernel at a
 * fraction of the taps. What makes it usable rather than just a blur is the
 * guidance: every tap is weighted down when its normal, its surface colour or
 * its distance disagrees with the centre pixel's. Those buffers come out of
 * the same camera rays for free and carry almost no noise, so edges the colour
 * alone could not distinguish from noise survive intact.
 *
 * Deliberately not adaptive to sample count in any clever way: the strength
 * comes from the caller, so a preview can filter hard and a final frame can
 * leave the detail alone.
 */

export interface DenoiseInput {
  width: number;
  height: number;
  /** Averaged radiance, 3 per pixel. */
  color: Float32Array;
  /** Averaged first-hit surface colour, 3 per pixel. */
  albedo: Float32Array;
  /** Averaged first-hit normal, 3 per pixel. */
  normal: Float32Array;
  /** Averaged first-hit distance, 1 per pixel. */
  depth: Float32Array;
}

export interface DenoiseOptions {
  /** Number of à-trous passes; each doubles the reach. */
  passes?: number;
  /**
   * How much colour difference is tolerated before a tap is rejected. Higher
   * filters harder. Scaled against the local variance so bright and dark parts
   * of the image are treated alike.
   */
  colorSigma?: number;
  normalSigma?: number;
  albedoSigma?: number;
  depthSigma?: number;
}

/** The 5-tap B3 spline the à-trous filter is built from. */
const KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];

/**
 * Divide out the surface colour before filtering and put it back after.
 *
 * Texture detail is not noise, but a filter cannot tell the difference. Taking
 * the albedo out leaves only the lighting — which really is smooth almost
 * everywhere — so the filter can work hard without turning a brick wall into a
 * flat surface.
 */
function demodulate(color: Float32Array, albedo: Float32Array, out: Float32Array): void {
  for (let i = 0; i < color.length; i++) {
    const a = albedo[i];
    out[i] = a > 0.01 ? color[i] / a : color[i];
  }
}

function remodulate(lit: Float32Array, albedo: Float32Array, out: Float32Array): void {
  for (let i = 0; i < lit.length; i++) {
    const a = albedo[i];
    out[i] = a > 0.01 ? lit[i] * a : lit[i];
  }
}

/**
 * Per-pixel luminance variance over a 3×3 window, used to scale the colour
 * rejection. Where the image is genuinely busy the filter backs off; where it
 * is flat and noisy it filters hard.
 */
function localVariance(color: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 3) {
    luma[i] = color[p] * 0.2126 + color[p + 1] * 0.7152 + color[p + 2] * 0.0722;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let sq = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = luma[yy * width + xx];
          sum += v;
          sq += v * v;
          n++;
        }
      }
      const mean = sum / n;
      out[y * width + x] = Math.max(0, sq / n - mean * mean);
    }
  }
  return out;
}

export function denoise(input: DenoiseInput, options: DenoiseOptions = {}): Float32Array {
  const { width, height, albedo, normal, depth } = input;
  const passes = options.passes ?? 4;
  const colorSigma = options.colorSigma ?? 4;
  const normalSigma = options.normalSigma ?? 0.2;
  const albedoSigma = options.albedoSigma ?? 0.15;
  const depthSigma = options.depthSigma ?? 0.6;
  const n = width * height;
  if (n === 0) return new Float32Array(0);

  let src = new Float32Array(n * 3);
  demodulate(input.color, albedo, src);
  let dst = new Float32Array(n * 3);
  const variance = localVariance(src, width, height);

  for (let pass = 0; pass < passes; pass++) {
    const stride = 1 << pass;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ci = y * width + x;
        const c3 = ci * 3;
        const cn0 = normal[c3];
        const cn1 = normal[c3 + 1];
        const cn2 = normal[c3 + 2];
        const cd = depth[ci];
        const ca0 = albedo[c3];
        const ca1 = albedo[c3 + 1];
        const ca2 = albedo[c3 + 2];
        // The colour test loosens where the estimate is itself uncertain,
        // otherwise noise reads as an edge and nothing gets filtered.
        const colorScale = 1 / (colorSigma * Math.sqrt(variance[ci]) + 1e-3);

        let r = 0;
        let g = 0;
        let b = 0;
        let wsum = 0;
        for (let ky = 0; ky < 5; ky++) {
          const yy = y + (ky - 2) * stride;
          if (yy < 0 || yy >= height) continue;
          for (let kx = 0; kx < 5; kx++) {
            const xx = x + (kx - 2) * stride;
            if (xx < 0 || xx >= width) continue;
            const si = yy * width + xx;
            const s3 = si * 3;

            // Normals: a fold in the surface is an edge whatever the colour.
            const dotN = cn0 * normal[s3] + cn1 * normal[s3 + 1] + cn2 * normal[s3 + 2];
            const wn = Math.exp(-Math.max(0, 1 - dotN) / (normalSigma * normalSigma + 1e-6));

            // Depth: two surfaces can share a normal and still be far apart.
            const dd = Math.abs(cd - depth[si]) / (Math.abs(cd) * depthSigma + 1e-3);
            const wd = Math.exp(-dd * dd);

            // Albedo: the boundary between two materials, texture included.
            const da =
              Math.abs(ca0 - albedo[s3]) + Math.abs(ca1 - albedo[s3 + 1]) + Math.abs(ca2 - albedo[s3 + 2]);
            const wa = Math.exp(-(da * da) / (albedoSigma * albedoSigma + 1e-6));

            const dc =
              Math.abs(src[c3] - src[s3]) +
              Math.abs(src[c3 + 1] - src[s3 + 1]) +
              Math.abs(src[c3 + 2] - src[s3 + 2]);
            const wc = Math.exp(-dc * colorScale);

            const w = KERNEL[ky] * KERNEL[kx] * wn * wd * wa * wc;
            if (w <= 0) continue;
            r += src[s3] * w;
            g += src[s3 + 1] * w;
            b += src[s3 + 2] * w;
            wsum += w;
          }
        }
        if (wsum > 0) {
          dst[c3] = r / wsum;
          dst[c3 + 1] = g / wsum;
          dst[c3 + 2] = b / wsum;
        } else {
          dst[c3] = src[c3];
          dst[c3 + 1] = src[c3 + 1];
          dst[c3 + 2] = src[c3 + 2];
        }
      }
    }
    const swap = src;
    src = dst;
    dst = swap;
  }

  const out = new Float32Array(n * 3);
  remodulate(src, albedo, out);
  return out;
}
