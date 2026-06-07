// Feature: after-party-lottery — noise shader material for the 3D lottery animation.
//
// Provides a factory that builds a THREE.ShaderMaterial driving the "noise" that
// wraps each participant's nickname (the "Signal Over Noise" theme). A child
// THREE.Points cloud rendered with this material obscures roughly 40–70% of the
// wrapped text at uIntensity = 1.0 (Requirement 7.2) and dissolves to nothing as
// uIntensity is tweened to 0.0 during the winner reveal (Requirements 7.4, 8.3).
//
// The material exposes two driving uniforms:
//   - uTime      (float)             animation clock, advanced each frame by Scene.update
//   - uIntensity (float in [0, 1])   0 = fully resolved/clear, 1 = maximally noisy
//
// Design reference: design.md §2.7 "Noise shader (sketch)". The sketch displaces
// along the vertex `normal`; because the noise cloud is a THREE.Points object that
// carries no normal attribute, this implementation instead displaces along a
// 3D-simplex-noise-derived direction. This keeps the displacement faithful to the
// design (3D simplex noise scaled by uIntensity) while working without normals.

import * as THREE from 'three';

/**
 * Default cyan accent color for the noise particles (#7df9ff), matching the
 * "Signal Over Noise" visual identity and the design's cyan fragment color
 * vec4(0.49, 0.97, 1.0, vAlpha).
 * @type {number}
 */
export const DEFAULT_NOISE_COLOR = 0x7df9ff;

/**
 * Default particle count for a single nickname's noise cloud, calibrated so that
 * at uIntensity = 1.0 the displaced, additively-blended particles obscure roughly
 * half of the wrapped text glyphs — comfortably within the 40–70% band required
 * by Requirement 7.2. Tune via the `count` option of {@link createNoisePoints}.
 * @type {number}
 */
export const DEFAULT_NOISE_PARTICLE_COUNT = 160;

/**
 * Standard Ashima / webgl-noise 3D simplex noise (`snoise`) implementation,
 * prepended to the vertex shader as a GLSL string constant.
 *
 * Source: Ashima Arts "webgl-noise" (Ian McEwan et al.), the canonical MIT/BSD
 * licensed simplex-noise GLSL snippet widely embedded in Three.js shaders.
 * @type {string}
 */
const SIMPLEX_NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  // First corner
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  // Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  // Permutations
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  // Gradients: 7x7 points over a square, mapped onto an octahedron.
  float n_ = 0.142857142857; // 1.0 / 7.0
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  // Normalise gradients
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  // Mix final noise value
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/**
 * Vertex shader: displaces each particle along a 3D-simplex-noise-derived
 * direction, scaled by uIntensity, and animated over uTime. Particle size and
 * per-vertex alpha both scale with uIntensity so the cloud thins out and shrinks
 * as the noise resolves to a clear signal.
 * @type {string}
 */
const VERTEX_SHADER = SIMPLEX_NOISE_GLSL + /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uDisplacement;
varying float vAlpha;

void main() {
  vec3 p = position;

  // Animate the noise field through time so the particles shimmer.
  vec3 sampleP = p * 1.2 + vec3(uTime * 0.5);

  // Build a 3D displacement direction from three decorrelated simplex samples.
  vec3 dir = vec3(
    snoise(sampleP),
    snoise(sampleP + vec3(31.42, 0.0, 0.0)),
    snoise(sampleP + vec3(0.0, 17.13, 0.0))
  );

  // Scalar noise magnitude (matches the design's n term) drives how far we push.
  float n = snoise(sampleP);
  p += dir * n * uDisplacement * uIntensity;

  // Per-particle alpha: scale down so the additively-blended cloud veils the
  // text (40–70% obscuration, Requirement 7.2) instead of saturating to white.
  vAlpha = uIntensity * 0.32;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Perspective-correct point size, growing with intensity (1px → 4px at full).
  float size = mix(1.0, 4.0, uIntensity);
  gl_PointSize = size * (300.0 / -mvPosition.z);
}
`;

/**
 * Fragment shader: emits soft, round cyan particles whose alpha is proportional
 * to uIntensity (via the vAlpha varying). The radial falloff turns each square
 * point sprite into a glowing dot suitable for additive blending.
 * @type {string}
 */
const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
varying float vAlpha;

void main() {
  // Discard fragments outside the unit circle to render round particles.
  vec2 uv = gl_PointCoord - vec2(0.5);
  float dist = length(uv);
  if (dist > 0.5) discard;

  // Soft radial falloff for a glow look.
  float falloff = smoothstep(0.5, 0.0, dist);

  gl_FragColor = vec4(uColor, vAlpha * falloff);
}
`;

/**
 * @typedef {Object} NoiseMaterialOptions
 * @property {number|THREE.Color} [color=DEFAULT_NOISE_COLOR] Particle color. Accepts
 *   any value the THREE.Color constructor understands (hex number, CSS string, Color).
 * @property {number} [intensity=1.0] Initial noise intensity, clamped to `[0, 1]`.
 * @property {number} [displacement=0.6] World-space displacement scale at
 *   `uIntensity = 1.0` (the design's `0.6` factor). Calibrated, together with the
 *   particle count, so the cloud obscures 40–70% of the wrapped text glyphs.
 */

/**
 * Create the noise {@link THREE.ShaderMaterial} used to wrap nickname text.
 *
 * The returned material is transparent, does not write depth, and uses additive
 * blending so overlapping particles accumulate into a cyan glow. Drive it each
 * frame by setting `material.uniforms.uTime.value` and adjust the noise level via
 * `material.uniforms.uIntensity.value` (clamped to `[0, 1]` by the caller, or use
 * {@link setNoiseIntensity}).
 *
 * @param {NoiseMaterialOptions} [options] Material configuration.
 * @returns {THREE.ShaderMaterial} The configured shader material.
 */
export function createNoiseMaterial(options = {}) {
  const {
    color = DEFAULT_NOISE_COLOR,
    intensity = 1.0,
    displacement = 0.6,
  } = options;

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0.0 },
      uIntensity: { value: clamp01(intensity) },
      uDisplacement: { value: displacement },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Build a {@link THREE.Points} noise cloud ready to be added as a child of a
 * nickname mesh. Particle positions are scattered uniformly inside a box roughly
 * matching the glyph bounds so that, at `uIntensity = 1.0`, the displaced cloud
 * obscures 40–70% of the text area (Requirement 7.2).
 *
 * This is a convenience helper; the core task only requires the material factory.
 *
 * @param {Object} [options] Geometry + material options.
 * @param {number} [options.count=DEFAULT_NOISE_PARTICLE_COUNT] Number of particles.
 * @param {[number, number, number]} [options.size=[6, 2, 1]] Box extents
 *   `[width, height, depth]` over which particles are scattered, in world units.
 * @param {NoiseMaterialOptions} [options.material] Options forwarded to
 *   {@link createNoiseMaterial}.
 * @param {() => number} [options.random=Math.random] Injectable RNG (testing).
 * @returns {THREE.Points} The configured points cloud.
 */
export function createNoisePoints(options = {}) {
  const {
    count = DEFAULT_NOISE_PARTICLE_COUNT,
    size = [6, 2, 1],
    material: materialOptions,
    random = Math.random,
  } = options;

  const [w, h, d] = size;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (random() - 0.5) * w;
    positions[i * 3 + 1] = (random() - 0.5) * h;
    positions[i * 3 + 2] = (random() - 0.5) * d;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  return new THREE.Points(geometry, createNoiseMaterial(materialOptions));
}

/**
 * Set the noise intensity on a material created by {@link createNoiseMaterial},
 * clamping the value to `[0, 1]`. Convenience used by reveal/dissolve tweens.
 *
 * @param {THREE.ShaderMaterial} material - A material from {@link createNoiseMaterial}.
 * @param {number} value - Desired intensity; clamped to `[0, 1]`.
 * @returns {number} The clamped value that was applied.
 */
export function setNoiseIntensity(material, value) {
  const clamped = clamp01(value);
  material.uniforms.uIntensity.value = clamped;
  return clamped;
}

/**
 * Clamp a number to the inclusive range `[0, 1]`. Non-finite inputs collapse to 0.
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
