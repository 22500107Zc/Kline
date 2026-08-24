/** GLSL ES 3.00 sources for the viewport. */

export const MAX_LIGHTS = 8;
export const MAX_MATERIALS = 32;

const COMMON = `
const float PI = 3.14159265359;

vec3 acesTonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 encodeSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

float distributionGGX(vec3 n, vec3 h, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float ndh = max(dot(n, h), 0.0);
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

float geometrySchlick(float ndv, float rough) {
  float r = rough + 1.0;
  float k = (r * r) / 8.0;
  return ndv / (ndv * (1.0 - k) + k);
}

vec3 fresnelSchlick(float ct, vec3 f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - ct, 0.0, 1.0), 5.0);
}

vec3 shadePBR(vec3 n, vec3 v, vec3 l, vec3 radiance, vec3 albedo, float metallic, float rough) {
  vec3 h = normalize(v + l);
  float ndl = max(dot(n, l), 0.0);
  if (ndl <= 0.0) return vec3(0.0);
  float ndv = max(dot(n, v), 1e-4);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  float ndf = distributionGGX(n, h, rough);
  float g = geometrySchlick(ndv, rough) * geometrySchlick(ndl, rough);
  vec3 f = fresnelSchlick(max(dot(h, v), 0.0), f0);
  vec3 spec = (ndf * g * f) / max(4.0 * ndv * ndl, 1e-4);
  vec3 kd = (vec3(1.0) - f) * (1.0 - metallic);
  return (kd * albedo / PI + spec) * radiance * ndl;
}
`;

export const MAX_TEXTURES = 8;
export const TEXTURE_SIZE = 1024;

export const SURFACE_VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
in float aFlags;
in float aMatId;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat4 uNormalMat;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
flat out float vFlags;
flat out int vMat;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize((uNormalMat * vec4(aNormal, 0.0)).xyz);
  vUV = aUV;
  vFlags = aFlags;
  vMat = int(aMatId + 0.5);
  gl_Position = uViewProj * world;
}
`;

export const SURFACE_FRAG = `#version 300 es
precision highp float;
${COMMON}

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
flat in float vFlags;
flat in int vMat;

uniform vec3 uCamPos;
uniform int uLightCount;
// xyz = position (or direction for sun), w = type: 0 point, 1 sun, 2 spot, 3 area
uniform vec4 uLightPos[${MAX_LIGHTS}];
// rgb = colour * energy, w = cos(spot angle)
uniform vec4 uLightColor[${MAX_LIGHTS}];
// xyz = aim direction, w = radius
uniform vec4 uLightDir[${MAX_LIGHTS}];

uniform vec3 uMatColor[${MAX_MATERIALS}];
uniform vec2 uMatMR[${MAX_MATERIALS}];
uniform vec4 uMatEmit[${MAX_MATERIALS}];
uniform float uMatAlpha[${MAX_MATERIALS}];
// Layer in the texture array, or -1 for an untextured material.
uniform float uMatTexLayer[${MAX_MATERIALS}];
uniform vec4 uMatUV[${MAX_MATERIALS}];   // xy = scale, zw = offset
uniform mediump sampler2DArray uTextures;
uniform float uUVCheck;                  // 1 = draw the procedural UV grid

uniform vec3 uAmbient;
uniform int uShadingMode;      // 0 = studio solid, 1 = material/rendered
uniform vec3 uSelectColor;
uniform float uObjectSelected; // 0..1 tint for object-mode selection
uniform float uOpacity;

out vec4 fragColor;

vec3 studio(vec3 n, vec3 v, vec3 albedo, float rough) {
  // Three-point studio rig that follows the camera, like Blender's solid mode.
  vec3 right = normalize(cross(v, vec3(0.0, 0.0, 1.0)) + vec3(1e-5));
  vec3 up = normalize(cross(right, v));
  vec3 key = normalize(v * 0.6 + up * 0.75 + right * 0.5);
  vec3 fill = normalize(v * 0.7 - right * 0.8 + up * 0.1);
  vec3 rim = normalize(-v * 0.3 + up * 0.6 - right * 0.4);
  vec3 c = vec3(0.0);
  c += shadePBR(n, v, key, vec3(2.6), albedo, 0.0, rough);
  c += shadePBR(n, v, fill, vec3(0.75, 0.78, 0.9), albedo, 0.0, rough);
  c += shadePBR(n, v, rim, vec3(0.55, 0.5, 0.45), albedo, 0.0, rough);
  c += albedo * (0.16 + 0.14 * (n.z * 0.5 + 0.5));
  return c;
}

// Procedural checker for judging an unwrap without loading an image.
vec3 uvGrid(vec2 uv) {
  vec2 cell = floor(uv * 8.0);
  float odd = mod(cell.x + cell.y, 2.0);
  vec3 base = mix(vec3(0.055, 0.062, 0.075), vec3(0.72, 0.70, 0.66), odd);
  vec2 g = abs(fract(uv * 8.0) - 0.5);
  float line = 1.0 - smoothstep(0.44, 0.5, max(g.x, g.y));
  base = mix(base * 0.55, base, line);
  // Tint the axes so flips and rotations are visible.
  base = mix(base, vec3(0.62, 0.13, 0.2), step(uv.x, 0.125) * step(uv.y, 0.125));
  base = mix(base, vec3(0.1, 0.5, 0.42), step(0.875, uv.x) * step(0.875, uv.y));
  return base;
}

void main() {
  int mi = clamp(vMat, 0, ${MAX_MATERIALS - 1});
  vec3 albedo = uMatColor[mi];
  vec2 uv = vUV * uMatUV[mi].xy + uMatUV[mi].zw;
  float layer = uMatTexLayer[mi];
  if (layer >= 0.0) {
    vec4 tex = texture(uTextures, vec3(fract(uv), layer));
    // Textures are authored in sRGB; shading happens in linear.
    vec3 lin = mix(pow((tex.rgb + 0.055) / 1.055, vec3(2.4)), tex.rgb / 12.92, step(tex.rgb, vec3(0.04045)));
    albedo *= lin;
  }
  if (uUVCheck > 0.5) albedo = uvGrid(vUV);
  float metallic = uMatMR[mi].x;
  float rough = clamp(uMatMR[mi].y, 0.03, 1.0);
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);
  if (!gl_FrontFacing) n = -n;

  vec3 color;
  if (uShadingMode == 0) {
    color = studio(n, v, albedo, rough);
  } else {
    color = albedo * uAmbient;
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= uLightCount) break;
      vec4 lp = uLightPos[i];
      vec3 radiance = uLightColor[i].rgb;
      vec3 l;
      if (lp.w < 0.5) {                       // point
        vec3 d = lp.xyz - vWorld;
        float dist2 = max(dot(d, d), 1e-4);
        l = normalize(d);
        radiance /= (4.0 * PI * dist2);
      } else if (lp.w < 1.5) {                // sun
        l = normalize(-uLightDir[i].xyz);
      } else if (lp.w < 2.5) {                // spot
        vec3 d = lp.xyz - vWorld;
        float dist2 = max(dot(d, d), 1e-4);
        l = normalize(d);
        float cosA = dot(normalize(uLightDir[i].xyz), -l);
        float edge = smoothstep(uLightColor[i].w, mix(uLightColor[i].w, 1.0, 0.25), cosA);
        radiance *= edge / (4.0 * PI * dist2);
      } else {                                // area, approximated as a disc-ish point
        vec3 d = lp.xyz - vWorld;
        float dist2 = max(dot(d, d), 1e-4);
        l = normalize(d);
        float facing = max(dot(normalize(-uLightDir[i].xyz), -l), 0.0);
        radiance *= facing / (PI * dist2);
      }
      color += shadePBR(n, v, l, radiance, albedo, metallic, rough);
    }
    color += uMatEmit[mi].rgb * uMatEmit[mi].w;
  }

  color = mix(color, uSelectColor, vFlags * 0.32);
  color = mix(color, uSelectColor * 0.85, uObjectSelected * 0.10);
  fragColor = vec4(encodeSRGB(acesTonemap(color)), uMatAlpha[mi] * uOpacity);
}
`;

export const OUTLINE_VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat4 uNormalMat;
uniform float uWidth;
uniform vec3 uCamPos;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec3 n = normalize((uNormalMat * vec4(aNormal, 0.0)).xyz);
  float d = length(uCamPos - world.xyz);
  gl_Position = uViewProj * vec4(world.xyz + n * uWidth * d, 1.0);
}
`;

export const OUTLINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() { fragColor = vec4(uColor, 1.0); }
`;

export const LINE_VERT = `#version 300 es
in vec3 aPos;
in vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uDepthBias;
out vec3 vColor;
void main() {
  vColor = aColor;
  vec4 clip = uViewProj * uModel * vec4(aPos, 1.0);
  clip.z -= uDepthBias * clip.w;
  gl_Position = clip;
}
`;

export const LINE_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uAlpha;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, uAlpha); }
`;

export const POINT_VERT = `#version 300 es
in vec3 aPos;
in float aFlags;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uSize;
uniform float uDepthBias;
flat out float vFlags;
void main() {
  vFlags = aFlags;
  vec4 clip = uViewProj * uModel * vec4(aPos, 1.0);
  clip.z -= uDepthBias * clip.w;
  gl_Position = clip;
  gl_PointSize = uSize * (aFlags > 0.5 ? 1.25 : 1.0);
}
`;

export const POINT_FRAG = `#version 300 es
precision highp float;
flat in float vFlags;
uniform vec3 uColor;
uniform vec3 uSelectColor;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  vec3 c = vFlags > 0.5 ? uSelectColor : uColor;
  float edge = smoothstep(0.25, 0.16, r);
  fragColor = vec4(mix(c * 0.25, c, edge), 1.0);
}
`;

export const GRID_VERT = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const GRID_FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;

uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uSpacing;
uniform float uFadeDistance;
uniform vec3 uLineColor;
uniform vec3 uXAxisColor;
uniform vec3 uYAxisColor;

out vec4 fragColor;

vec3 unproject(float z) {
  vec4 p = uInvViewProj * vec4(vNdc, z, 1.0);
  return p.xyz / p.w;
}

float gridMask(vec2 coord, float spacing) {
  vec2 c = coord / spacing;
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-6));
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  vec3 near = unproject(-1.0);
  vec3 far = unproject(1.0);
  float denom = far.z - near.z;
  if (abs(denom) < 1e-9) discard;
  float t = -near.z / denom;
  if (t < 0.0 || t > 1.0) discard;
  vec3 world = near + t * (far - near);

  float fine = gridMask(world.xy, uSpacing);
  float coarse = gridMask(world.xy, uSpacing * 10.0);
  float dist = length(world - uCamPos);
  float fade = 1.0 - smoothstep(uFadeDistance * 0.35, uFadeDistance, dist);
  float alpha = max(fine * 0.35, coarse * 0.65) * fade;

  vec2 aw = fwidth(world.xy);
  float xAxis = 1.0 - min(abs(world.y) / max(aw.y, 1e-6), 1.0);
  float yAxis = 1.0 - min(abs(world.x) / max(aw.x, 1e-6), 1.0);

  vec3 color = uLineColor;
  color = mix(color, uXAxisColor, xAxis);
  color = mix(color, uYAxisColor, yAxis);
  alpha = max(alpha, max(xAxis, yAxis) * fade);
  if (alpha < 0.002) discard;

  vec4 clip = uViewProj * vec4(world, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  fragColor = vec4(color, alpha);
}
`;
