import { AABB, Mat4, Vec3, clamp } from '../core/math';

export type AxisView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/**
 * Orbit camera for the 3D viewport. Z-up spherical coordinates around a pivot,
 * with a perspective/orthographic toggle that preserves apparent zoom.
 */
/**
 * Every number that reaches a camera move comes from somewhere else — a wheel
 * event, a saved file, a line typed into the console — and one NaN among them
 * is not a bad frame, it is the end of the session. NaN spreads through the
 * view matrix in a single step, the viewport goes blank, and no gesture can
 * put it back, because every gesture is relative to the value that is now
 * NaN. The only way out is reloading and losing the work.
 *
 * `clamp` does not catch it either: every comparison against NaN is false, so
 * it passes straight through the range check it looks like it is guarded by.
 * Refusing the input costs one comparison and cannot make anything worse.
 */
function usable(...values: number[]): boolean {
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}

export class ViewportCamera {
  target = new Vec3(0, 0, 0);
  distance = 11;
  /** Azimuth around +Z, radians. */
  yaw = -43 * (Math.PI / 180);
  /** Elevation above the XY plane, radians, clamped to just under the poles. */
  pitch = 27 * (Math.PI / 180);
  fov = 39.6 * (Math.PI / 180);
  near = 0.02;
  far = 5000;
  orthographic = false;
  /** Set while looking through a scene camera; overrides the orbit transform. */
  lockedMatrix: Mat4 | null = null;

  eye(): Vec3 {
    if (this.lockedMatrix) {
      const m = this.lockedMatrix.m;
      return new Vec3(m[12], m[13], m[14]);
    }
    const cp = Math.cos(this.pitch);
    return this.target.add(
      new Vec3(cp * Math.cos(this.yaw), cp * Math.sin(this.yaw), Math.sin(this.pitch))
        .scale(this.distance),
    );
  }

  forward(): Vec3 {
    if (this.lockedMatrix) return this.lockedMatrix.transformDirection(new Vec3(0, 0, -1)).normalized();
    return this.target.sub(this.eye()).normalized();
  }

  right(): Vec3 {
    return this.forward().cross(new Vec3(0, 0, 1)).normalized();
  }

  up(): Vec3 {
    return this.right().cross(this.forward()).normalized();
  }

  viewMatrix(): Mat4 {
    if (this.lockedMatrix) return this.lockedMatrix.inverse();
    return Mat4.lookAt(this.eye(), this.target, new Vec3(0, 0, 1));
  }

  /** Half-height of the ortho frustum, matched to the perspective framing. */
  orthoHalfHeight(): number {
    return Math.tan(this.fov / 2) * this.distance;
  }

  projectionMatrix(aspect: number): Mat4 {
    if (this.orthographic) {
      const h = this.orthoHalfHeight();
      const w = h * aspect;
      return Mat4.orthographic(-w, w, -h, h, -this.far, this.far);
    }
    return Mat4.perspective(this.fov, aspect, this.near, this.far);
  }

  viewProjection(aspect: number): Mat4 {
    return this.projectionMatrix(aspect).multiply(this.viewMatrix());
  }

  orbit(dx: number, dy: number): void {
    if (!usable(dx, dy)) return;
    this.lockedMatrix = null;
    this.yaw -= dx;
    this.pitch = clamp(this.pitch + dy, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
  }

  /** Pan in screen space; `dx`/`dy` are pixel deltas. */
  pan(dx: number, dy: number, viewportHeight: number): void {
    if (!usable(dx, dy, viewportHeight)) return;
    this.lockedMatrix = null;
    const worldPerPixel = (2 * this.orthoHalfHeight()) / Math.max(1, viewportHeight);
    this.target = this.target
      .add(this.right().scale(-dx * worldPerPixel))
      .add(this.up().scale(dy * worldPerPixel));
  }

  /** `amount` > 0 zooms in. */
  zoom(amount: number): void {
    if (!usable(amount)) return;
    this.lockedMatrix = null;
    this.distance = clamp(this.distance * Math.pow(0.9, amount), 0.01, 20000);
  }

  /**
   * Zoom while keeping whatever is under a screen point where it is.
   *
   * `ndcX` and `ndcY` run -1 to 1 across the viewport with +Y up. Zooming
   * about the middle instead means the thing you were looking at slides away
   * as you approach it, and you spend the whole time chasing it back with the
   * pan gesture — which is most of what makes a viewport feel like work.
   */
  zoomAt(amount: number, ndcX: number, ndcY: number, aspect: number): void {
    if (!usable(amount, ndcX, ndcY, aspect)) return;
    const before = this.orthoHalfHeight();
    this.zoom(amount);
    const shift = before - this.orthoHalfHeight();
    if (!Number.isFinite(shift) || shift === 0) return;
    // The point under the cursor sits at target + right·ndcX·h·aspect + up·ndcY·h,
    // so holding it still while h changes is a translation of the pivot by the
    // difference. Orientation does not change, so right and up are the same
    // before and after.
    this.target = this.target
      .add(this.right().scale(ndcX * shift * aspect))
      .add(this.up().scale(ndcY * shift));
  }

  /** Dolly the pivot forward/back, keeping the orbit distance (Blender's Ctrl+MMB feel). */
  dolly(amount: number): void {
    if (!usable(amount)) return;
    this.lockedMatrix = null;
    this.target = this.target.add(this.forward().scale(amount * this.distance * 0.1));
  }

  frame(box: AABB, padding = 1.4): void {
    if (!box.valid || !usable(padding)) return;
    const centre = box.center();
    const radius = Math.max(box.radius(), 0.15);
    const distance = clamp((radius * padding) / Math.tan(this.fov / 2), 0.05, 20000);
    // A box holding a NaN is still "valid" as far as the flag goes — one
    // vertex that went wrong upstream is enough — so the framing is worked out
    // first and only committed once it is a place the camera can actually be.
    if (!usable(centre.x, centre.y, centre.z, distance)) return;
    this.lockedMatrix = null;
    this.target = centre;
    this.distance = distance;
  }

  setAxisView(view: AxisView): void {
    this.lockedMatrix = null;
    const d = Math.PI / 180;
    switch (view) {
      case 'front': this.yaw = -90 * d; this.pitch = 0; break;
      case 'back': this.yaw = 90 * d; this.pitch = 0; break;
      case 'right': this.yaw = 0; this.pitch = 0; break;
      case 'left': this.yaw = 180 * d; this.pitch = 0; break;
      case 'top': this.yaw = -90 * d; this.pitch = 89.999 * d; break;
      case 'bottom': this.yaw = -90 * d; this.pitch = -89.999 * d; break;
    }
  }

  /** Rotate the view by 15° steps, as the numpad arrows do. */
  nudge(dyaw: number, dpitch: number): void {
    this.orbit(-dyaw, dpitch);
  }

  /** Ray through a pixel. `x`/`y` are in CSS pixels with y down. */
  screenRay(x: number, y: number, width: number, height: number): { origin: Vec3; dir: Vec3 } {
    const ndcX = (x / width) * 2 - 1;
    const ndcY = 1 - (y / height) * 2;
    const inv = this.viewProjection(width / Math.max(1, height)).inverse();
    const p0 = inv.transformPoint(new Vec3(ndcX, ndcY, -1));
    const p1 = inv.transformPoint(new Vec3(ndcX, ndcY, 1));
    const dir = p1.sub(p0).normalized();
    return { origin: this.orthographic ? p0 : this.eye(), dir };
  }

  /** Project a world point to pixel coordinates; `z` is NDC depth. */
  worldToScreen(p: Vec3, width: number, height: number): { x: number; y: number; z: number } {
    const clip = this.viewProjection(width / Math.max(1, height)).transformPoint(p);
    return { x: ((clip.x + 1) / 2) * width, y: ((1 - clip.y) / 2) * height, z: clip.z };
  }

  /** World units per screen pixel at a given point — used to keep gizmos a constant size. */
  pixelScaleAt(p: Vec3, height: number): number {
    if (this.orthographic) return (2 * this.orthoHalfHeight()) / Math.max(1, height);
    const dist = Math.max(0.001, p.sub(this.eye()).dot(this.forward()));
    return (2 * Math.tan(this.fov / 2) * dist) / Math.max(1, height);
  }

  clone(): ViewportCamera {
    const c = new ViewportCamera();
    c.target = this.target.clone();
    c.distance = this.distance;
    c.yaw = this.yaw;
    c.pitch = this.pitch;
    c.fov = this.fov;
    c.orthographic = this.orthographic;
    return c;
  }
}
