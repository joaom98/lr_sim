// Mirage: heat shimmer seen through the scope. The scene is rendered to a texture, then drawn
// through a shader that bends the image in thin horizontal layers. The layers run sideways
// with the crosswind (fast and flat in wind, a slow upward "boil" in calm air), which is how
// shooters read wind at distance.
import * as THREE from "three";

const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragment = /* glsl */ `
uniform sampler2D tScene;
uniform float uTime;
uniform float uStrength;   // displacement amplitude, in UV units
uniform float uDrift;      // sideways layer speed (UV/s), + = to the right
uniform float uBoil;       // 0..1, how much the layers rise instead of running sideways
uniform float uAspect;
varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  float x = uv.x * uAspect;
  // Thin layers: high frequency in y, long and wavy in x, advected by the wind.
  float layer = uv.y * 260.0 + sin(x * 9.0 - uTime * 1.3) * 1.5;
  float run = x * 38.0 - uTime * uDrift * 38.0 * uAspect;
  float rise = uv.y * 140.0 - uTime * 2.6;
  float a = sin(layer + sin(run) * 1.8 + uBoil * sin(rise) * 2.2);
  float b = sin(layer * 1.73 + run * 0.6 + uTime * 0.9);
  vec2 off = vec2(a * 0.35, a * 0.8 + b * 0.4) * uStrength;
  gl_FragColor = texture2D(tScene, uv + off);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class MiragePass {
  private rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        tScene: { value: this.rt.texture },
        uTime: { value: 0 },
        uStrength: { value: 0 },
        uDrift: { value: 0 },
        uBoil: { value: 1 },
        uAspect: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /**
   * Render `scene` with mirage into the current viewport (`w` x `h` CSS pixels).
   * `strengthPx` is the shimmer amplitude in screen pixels; `driftPxPerS` the sideways speed.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    w: number,
    h: number,
    p: { time: number; strengthPx: number; driftPxPerS: number; boil: number },
  ) {
    const dpr = renderer.getPixelRatio();
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (this.rt.width !== pw || this.rt.height !== ph) this.rt.setSize(pw, ph);
    renderer.setRenderTarget(this.rt);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, w, h);
    const u = this.material.uniforms;
    u.uTime.value = p.time;
    u.uStrength.value = p.strengthPx / h;
    u.uDrift.value = p.driftPxPerS / w;
    u.uBoil.value = p.boil;
    u.uAspect.value = w / h;
    renderer.render(this.scene, this.cam);
  }
}

/** Mirage strength (0..1) from air temperature, humidity and sun. Hot, dry, sunny = strong. */
export function heatFactor(temperatureC: number, humidity: number): number {
  const t = Math.min(1, Math.max(0, (temperatureC - 2) / 30));
  return t * (1 - 0.35 * humidity);
}
