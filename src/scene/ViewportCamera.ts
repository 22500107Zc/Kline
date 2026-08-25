import { AABB, Mat4, Vec3, clamp } from '../core/math';

export type AxisView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/**
 * Orbit camera for the 3D viewport. Z-up spherical coordinates around a pivot,
 * with a perspective/orthographic toggle that preserves apparent zoom.
 */
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
    this.lockedMatrix = null;
    this.yaw -= dx;
    this.pitch = clamp(this.pitch + dy, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
  }

  /** Pan in screen space; `dx`/`dy` are pixel deltas. */
  pan(dx: number, dy: number, viewportHeight: number): void {
    this.lockedMatrix = null;
    const worldPerPixel = (2 * this.orthoHalfHeight()) / Math.max(1, viewportHeight);
    this.target = this.target
      .add(this.right().scale(-dx * worldPerPixel))
      .add(this.up().scale(dy * worldPerPixel));
  }

  /** `amount` > 0 zooms in. */
  zoom(amount: number): void {
    this.lockedMatrix = null;
    this.distance = clamp(this.distance * Math.pow(0.9, amount), 0.01, 20000);
  }

  /** Dolly the pivot forward/back, keeping the orbit distance (Blender's Ctrl+MMB feel). */
  dolly(amount: number): void {
    this.lockedMatrix = null;
    this.target = this.target.add(this.forward().scale(amount * this.distance * 0.1));
  }

  frame(box: AABB, padding = 1.4): void {
    if (!box.valid) return;
    this.lockedMatrix = null;
    this.target = box.center();
    const radius = Math.max(box.radius(), 0.15);
    this.distance = clamp((radius * padding) / Math.tan(this.fov / 2), 0.05, 20000);
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
