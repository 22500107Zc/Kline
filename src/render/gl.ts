/** Thin WebGL2 helpers: program compilation, uniform caching, dynamic buffers. */

export class Program {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private attribs = new Map<string, number>();

  constructor(private gl: WebGL2RenderingContext, vertexSrc: string, fragmentSrc: string, label = 'program') {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc, `${label}.vert`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc, `${label}.frag`);
    const p = gl.createProgram();
    if (!p) throw new Error('failed to create program');
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`${label} link failed: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = p;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  loc(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name) ?? null;
  }

  attrib(name: string): number {
    if (!this.attribs.has(name)) {
      this.attribs.set(name, this.gl.getAttribLocation(this.program, name));
    }
    return this.attribs.get(name) ?? -1;
  }

  setMat4(name: string, value: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix4fv(l, false, value);
  }
  setVec3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }
  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }
  setFloat(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  setInt(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  setFloatArray(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1fv(l, v);
  }
  setVec2Array(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2fv(l, v);
  }
  setVec3Array(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, v);
  }
  setVec4Array(name: string, v: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, v);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('failed to create shader');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`${label} compile failed: ${log}\n${numberLines(src)}`);
  }
  return s;
}

function numberLines(src: string): string {
  return src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
}

/** A growable interleaved vertex buffer with a cached upload. */
export class DynamicBuffer {
  readonly buffer: WebGLBuffer;
  private capacity = 0;
  count = 0;

  constructor(private gl: WebGL2RenderingContext, private target: number = gl.ARRAY_BUFFER) {
    const b = gl.createBuffer();
    if (!b) throw new Error('failed to create buffer');
    this.buffer = b;
  }

  upload(data: Float32Array, vertexCount: number): void {
    const gl = this.gl;
    gl.bindBuffer(this.target, this.buffer);
    if (data.byteLength > this.capacity) {
      gl.bufferData(this.target, data, gl.DYNAMIC_DRAW);
      this.capacity = data.byteLength;
    } else {
      gl.bufferSubData(this.target, 0, data);
    }
    this.count = vertexCount;
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}

/** An index buffer, kept alongside its vertex buffer. */
export class IndexBuffer {
  readonly buffer: WebGLBuffer;
  private capacity = 0;
  count = 0;

  constructor(private gl: WebGL2RenderingContext) {
    const b = gl.createBuffer();
    if (!b) throw new Error('failed to create index buffer');
    this.buffer = b;
  }

  upload(data: Uint32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffer);
    if (data.byteLength > this.capacity) {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.capacity = data.byteLength;
    } else {
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, data);
    }
    this.count = data.length;
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}

/**
 * Attribute arrays that are currently on, per context.
 *
 * Enabling an attribute array is context state, not program state — it
 * outlives the program that turned it on. A pass with fewer inputs than the
 * last one therefore inherits its leftovers, and the moment one of those
 * leftovers points at a buffer that has since been deleted, WebGL rejects
 * every draw with INVALID_OPERATION. Silently: the pass simply produces
 * nothing. Tracking what is on costs one Set and removes a whole class of
 * bug that is close to undiagnosable from the picture alone.
 */
const enabledAttribs = new WeakMap<WebGL2RenderingContext, Set<number>>();

/**
 * Point the program's attributes at the bound buffer, and turn off any array
 * left enabled by an earlier pass.
 */
export function setupAttribs(
  gl: WebGL2RenderingContext,
  program: Program,
  layout: { name: string; size: number }[],
): void {
  const stride = layout.reduce((s, a) => s + a.size, 0) * 4;
  let offset = 0;
  const live = new Set<number>();
  for (const a of layout) {
    const loc = program.attrib(a.name);
    if (loc >= 0) {
      live.add(loc);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, stride, offset);
    }
    offset += a.size * 4;
  }
  applyAttribs(gl, live);
}

/**
 * Record `live` as the enabled set and disable everything that was on before
 * and is not in it.
 *
 * Exported because not every pass has a named layout — the grid is a bare
 * fullscreen triangle — and a pass that sets its attributes by hand still has
 * to leave the context in a state the next pass can trust.
 */
export function applyAttribs(gl: WebGL2RenderingContext, live: Set<number>): void {
  const previous = enabledAttribs.get(gl);
  if (previous) {
    for (const loc of previous) if (!live.has(loc)) gl.disableVertexAttribArray(loc);
  }
  enabledAttribs.set(gl, new Set(live));
}
