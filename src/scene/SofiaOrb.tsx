import { useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * The plasma core — the "SOFIA" avatar.
 *
 * Recreated from the reference clip: a dark orb of deep navy plasma churned
 * by slow shear, one neon rim of light around its equator with a highlight
 * that travels it, a faint heart at the centre, and a soft halo breathing
 * off the edge into the void. The clip's measurements, taken off its frames:
 *
 *   interior  near-black navy (≈ rgb 4, 9, 46), dimmer at the centre than
 *             toward the wall, structured — not a flat gradient but
 *             filaments that drift and regroup over a few seconds;
 *   rim       the brightest element by far (mean ≈ 193 vs interior ≈ 60), a
 *             thick electric-blue band, constant in brightness frame to frame;
 *   highlight one sector of the rim glowing brighter than the rest, observed
 *             crossing ≈ 95° in 4.5 s — one lap in roughly seventeen seconds;
 *   halo      smooth light falling off outside the rim, no outer rings, no
 *             text, no particles — the orb is the whole subject.
 *
 * Everything is drawn in one camera-facing plane by a polar fragment shader,
 * like the reactor dial it can stand in for. The filaments are domain-warped
 * fractal noise sampled in a frame that rotates at a rate falling with
 * radius — the shear between the fast centre and the slower wall stretches
 * the noise into the swirls the clip shows, and a slow drift through the
 * noise's own coordinates keeps the pattern regenerating so the shear never
 * winds up into infinite spiral arms.
 *
 * The states the machine already speaks — phase colour, voice level, spin
 * energy, power-up reveal, and the ui_reactor tool's whole contract — arrive
 * through the same Drive the dial reads, so an orb that thinks is an amber
 * one churning hard, and one that speaks pulses green with the voice.
 */

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragment = /* glsl */ `
  uniform vec3  uColor;
  uniform vec3  uHot;
  uniform float uLevel;
  uniform float uPhase;
  uniform float uSwirl;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  uniform float uStyle;

  varying vec2 vUv;

  #define PI 3.14159265359
  #define TAU 6.28318530718

  // The orb's wall, in the shader's own field units.
  #define RIM 0.64

  float adist(float a, float c) {
    return mod(a - c + PI, TAU) - PI;
  }

  // An angular window centred on c: 1 inside hw radians, eased over soft.
  float awin(float a, float c, float hw, float soft) {
    return 1.0 - smoothstep(hw - soft, hw, abs(adist(a, c)));
  }

  vec2 rot2(vec2 p, float t) {
    float c = cos(t), s = sin(t);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // Four octaves, coordinates rotated between them so the noise itself has a
  // swirl to it before the shear ever touches it.
  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.55;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) {
      v += amp * vnoise(p);
      p = m * p;
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * uZoom;
    float r = length(p);
    float a = atan(p.y, p.x);
    float lv = uLevel;

    // -- style ---------------------------------------------------------------
    // The ui_reactor contract, mapped onto the orb: 'ring' is the authored
    // plasma form untouched, 'sphere' trades the filaments for a lit body,
    // 'wire' is the outline — the rim and a ghost of the interior.
    float wSphere = clamp(1.0 - abs(uStyle - 1.0), 0.0, 1.0);
    float wWire   = clamp(1.0 - abs(uStyle - 2.0), 0.0, 1.0);

    float kBody = mix(1.0, 1.30, wSphere) * mix(1.0, 0.30, wWire);
    float kRim  = mix(1.0, 0.70, wSphere) * mix(1.0, 1.50, wWire);
    float kHalo = mix(1.0, 1.25, wSphere) * mix(1.0, 0.00, wWire);

    // -- interior -------------------------------------------------------------
    // Sample the noise in a frame whose rotation rate falls with radius: the
    // centre turns faster than the wall, and the difference is the churn.
    float shear = uSwirl * (1.15 - r * 0.90);
    vec2 q = rot2(p, shear);

    // Domain-warp: one fbm displaces the coordinates of the second, which is
    // what makes the noise read as filaments of plasma rather than fog.
    float w1 = fbm(q * 3.1 + vec2(uPhase * 0.045, -uPhase * 0.032));
    float plasma = fbm(
      q * 3.6 + vec2(w1 * 1.7, -w1 * 1.3) + vec2(-uPhase * 0.026, uPhase * 0.019)
    );

    float fil = smoothstep(0.42, 0.74, plasma);
    // Fade out before the wall so the filaments never collide with the rim.
    fil *= 1.0 - smoothstep(RIM * 0.72, RIM * 1.02, r);
    // The clip's centre is darker than the mid-volume — plasma hangs toward
    // the wall, with a quiet heart.
    fil *= 0.30 + 0.70 * smoothstep(0.06, RIM * 0.85, r);

    float heart = exp(-r * r * 22.0) * (0.34 + lv * 0.34);

    // -- rim -------------------------------------------------------------------
    // The wall breathes a hair with the voice; the travelling highlight is
    // the clip's signature — one bright sector, a lap every ~17 s at rest,
    // faster while the machine works.
    float rimR = RIM * (1.0 + lv * 0.045);
    // The wall is the brightest thing on the screen, as in the clip — the
    // amplitude is set against the dial's own core ring (1.45) plus bloom,
    // so both avatars read at the same wattage.
    float rim = exp(-pow((r - rimR) / 0.035, 2.0)) * (2.05 + lv * 0.85);
    float hlA = mod(uPhase * 0.70, TAU);
    float hl = awin(a, hlA, 1.05, 0.95);
    rim *= 1.0 + hl * 1.35;

    // -- halo ------------------------------------------------------------------
    // Light bleeding off the wall into the void, brightest at the rim.
    float halo = exp(-pow(max(r - rimR, 0.0) / 0.22, 1.7))
               * (0.50 + lv * 0.30)
               * smoothstep(rimR - 0.02, rimR + 0.03, r);

    // -- assemble -----------------------------------------------------------------
    // The volume is navy whatever the phase is doing — the orb's glass — and
    // the energy riding in it carries the phase colour.
    vec3 deep = vec3(0.016, 0.055, 0.21);
    vec3 rimCol = mix(uColor, uHot, clamp(hl * 0.65, 0.0, 1.0));
    vec3 filCol = mix(uColor, uHot, fil * 0.35);
    vec3 heartCol = mix(deep, uColor, 0.55);

    vec3 acc = rimCol * (rim * kRim)
             + filCol * (fil * (1.05 + lv * 0.60) * kBody)
             + heartCol * (heart * kBody)
             + uColor * (halo * 0.75 * kHalo);

    // Power-up reveal: the heart lights first, the plasma blooms outward, the
    // rim ignites last — the inverse of the dial, which builds from the
    // centre too but is all rim by design.
    float front = uOpen * 1.25;
    acc *= 1.0 - smoothstep(front - 0.18, front, r / RIM);

    // Brightness authority for the whole orb, applied last. 1.0 is authored.
    acc *= uIntensity;

    float lum = max(max(acc.r, acc.g), acc.b);
    gl_FragColor = vec4(acc, clamp(lum, 0.0, 1.0));
  }
`

/** The plane's half-width in world units. Bigger than the dial's — the halo
 *  must fade to nothing before the quad's edge, and at this size the edge is
 *  off-screen entirely, so no square ever glances into view. */
const HALF = 3.5
/** Rim radius, in the shader's own field units — kept in step with the
 *  shader's own #define RIM. */
const RIM_R = 0.64
/**
 * Rim diameter as a fraction of the SHORTER viewport dimension — 0.58: a
 * ball reads heavier than a thin dial of the same width, so it sits a touch
 * smaller than the reactor's 0.70 while carrying the same presence.
 */
const FIT = 0.58

export function SofiaOrb({ drive }: { drive: Drive }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const viewport = useThree((s) => s.viewport)

  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color('#19c4c4') },
      uHot: { value: new THREE.Color('#b9fdff') },
      uLevel: { value: 0 },
      uPhase: { value: 0 },
      // Accumulated interior rotation, so rate changes never teleport the
      // plasma — the same rule the dial holds for its own layers.
      uSwirl: { value: 0 },
      uOpen: { value: 0 },
      uZoom: { value: 1.2 },
      uIntensity: { value: 1 },
      uStyle: { value: 0 },
    }),
    [],
  )

  useFrame((_, dt) => {
    if (!mat.current || !mesh.current) return
    const u = mat.current.uniforms
    const r = drive.reactor

    mesh.current.visible = r.visible
    mesh.current.scale.setScalar(r.scale)

    const fit = Math.min(viewport.width, viewport.height)
    u.uZoom.value = (RIM_R * HALF) / (FIT * 0.5 * fit)
    u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 8)
    // The highlight lap and the noise drift ride the phase clock; the
    // reactor slice's spin multiplier turns the whole lamp up and down.
    u.uPhase.value += dt * (0.5 + u.uLevel.value * 0.7) * r.spin
    // The churn: the spinFor table's energy, plus the voice itself.
    u.uSwirl.value +=
      dt * (0.14 + drive.spin * 0.10 + u.uLevel.value * 0.45)
    u.uOpen.value += (drive.open - u.uOpen.value) * Math.min(1, dt * 1.6)
    u.uIntensity.value = r.intensity
    u.uStyle.value = r.style
    ;(u.uColor.value as THREE.Color).lerp(r.color, Math.min(1, dt * 2.5))
  })

  return (
    <mesh ref={mesh} frustumCulled={false}>
      {/* One quad, camera-facing; the orb lives entirely in the fragment
          shader. Oversized on purpose — see HALF. */}
      <planeGeometry args={[2 * HALF, 2 * HALF]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  )
}
