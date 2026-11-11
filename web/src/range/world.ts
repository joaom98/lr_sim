// The 3-D range: terrain, sky, targets on stands, wind flags, trees and impact effects.
// World frame: x = right, y = up (firing-point ground = 0), z = toward the shooter
// (downrange is -z). The shooter's eye sits above the origin.
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { groundHeight, LANE_HALF_WIDTH_M } from "./terrain";
import type { RangeDef, TargetDef } from "./conditions";
import { Rand } from "../rng";

export interface TargetObj {
  def: TargetDef;
  /** plate centre (world) */
  center: THREE.Vector3;
  /** unit normal facing the shooter */
  normal: THREE.Vector3;
  /** unit vector to the shooter's right in the plate plane */
  right: THREE.Vector3;
  pivot: THREE.Group;
  plate: THREE.Mesh;
  marks: THREE.Group;
  halfHeight: number;
  swing: { amp: number; t0: number };
  meshes: THREE.Object3D[];
}

interface Flag {
  group: THREE.Group;
  geo: THREE.BufferGeometry;
  base: Float32Array;
  down: number;
  heading: number;
  speed: number;
  phase: number;
}

interface Puff {
  points: THREE.Points;
  vel: Float32Array;
  born: number;
  life: number;
}

interface Tracer {
  points: THREE.Points;
  path: THREE.Vector3[];
  times: number[];
  t0: number;
  visibility: number;
  onDone: () => void;
  /** time the bullet arrived (the wake then fades out), or null while in flight */
  impactAt: number | null;
  done: boolean;
}

/** Puffs in the bullet's wake and how far apart they sit (m). */
const TRACE_POINTS = 56;
const TRACE_SPACING_M = 1.1;

// The "trace": the bullet's wake refracting light, seen from behind as a soft, pale streak
// a few decimetres wide. Rendered as point sprites sized in metres (scaled by the camera's
// projection, so it reads correctly through any magnification) that fade toward the tail.
const traceVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAlpha;
attribute float aSize;
uniform float uHalfHeight;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Capped so a puff close to the scope can never flood the view.
  gl_PointSize = clamp(aSize * projectionMatrix[1][1] * uHalfHeight / -mv.z, 1.5, uHalfHeight * 0.06);
  vAlpha = aAlpha;
  #include <logdepthbuf_vertex>
}`;

const traceFragment = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vAlpha * (1.0 - smoothstep(0.25, 1.0, d));
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

export const world = (p: { down: number; right: number; up: number }) => new THREE.Vector3(p.right, p.up, -p.down);

/** Hit test in plate coordinates (u right, v up, metres from centre). */
export function insideShape(def: TargetDef, u: number, v: number): boolean {
  const w = def.sizeM;
  switch (def.shape) {
    case "circle":
      return u * u + v * v <= (w / 2) ** 2;
    case "square":
    case "paper":
      return Math.abs(u) <= w / 2 && Math.abs(v) <= w / 2;
    case "ipsc": {
      const h = def.heightM ?? w * 1.6;
      const body = Math.abs(u) <= w / 2 && v >= -h / 2 && v <= h / 2 - h * 0.25;
      const head = Math.abs(u) <= w / 4 && v > h / 2 - h * 0.25 && v <= h / 2;
      return body || head;
    }
  }
}

function plateGeometry(def: TargetDef): { geo: THREE.BufferGeometry; halfHeight: number } {
  const w = def.sizeM;
  switch (def.shape) {
    case "circle":
      return { geo: new THREE.CircleGeometry(w / 2, 40), halfHeight: w / 2 };
    case "square":
      return { geo: new THREE.PlaneGeometry(w, w), halfHeight: w / 2 };
    case "paper":
      return { geo: new THREE.PlaneGeometry(w, w), halfHeight: w / 2 };
    case "ipsc": {
      const h = def.heightM ?? w * 1.6;
      const s = new THREE.Shape();
      const top = h / 2 - h * 0.25;
      s.moveTo(-w / 2, -h / 2);
      s.lineTo(w / 2, -h / 2);
      s.lineTo(w / 2, top);
      s.lineTo(w / 4, top);
      s.lineTo(w / 4, h / 2);
      s.lineTo(-w / 4, h / 2);
      s.lineTo(-w / 4, top);
      s.lineTo(-w / 2, top);
      s.closePath();
      return { geo: new THREE.ShapeGeometry(s), halfHeight: h / 2 };
    }
  }
}

function paperTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f1e8";
  g.fillRect(0, 0, 512, 512);
  // Rings every 0.5 MOA-ish at 100 m (2.5 cm on a 50 cm sheet = 25.6 px)
  for (let i = 9; i >= 1; i--) {
    g.beginPath();
    g.arc(256, 256, i * 25.6, 0, Math.PI * 2);
    g.fillStyle = i <= 3 ? "#1b1b1b" : "#f4f1e8";
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = i <= 3 ? "#f4f1e8" : "#1b1b1b";
    g.stroke();
  }
  // 1-inch grid border
  g.strokeStyle = "rgba(40,90,170,0.5)";
  g.lineWidth = 1;
  for (let x = 0; x <= 512; x += 26) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 20);
    g.moveTo(x, 492);
    g.lineTo(x, 512);
    g.moveTo(0, x);
    g.lineTo(20, x);
    g.moveTo(492, x);
    g.lineTo(512, x);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function noiseTexture(seed: number, base: [number, number, number], spread: number): THREE.CanvasTexture {
  const r = new Rand(seed);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const img = g.createImageData(256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const n = (r.uniform() - 0.5) * spread;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n * 0.6;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textSprite(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f2efe6";
  g.fillRect(0, 0, 128, 64);
  g.strokeStyle = "#333";
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 60);
  g.fillStyle = "#1a1a1a";
  g.font = "bold 40px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: true }));
  return s;
}

function markerSprite(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ff7a1a";
  g.strokeStyle = "#2a1200";
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(8, 10);
  g.lineTo(56, 10);
  g.lineTo(32, 56);
  g.closePath();
  g.fill();
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: true, depthWrite: false }));
}

function softDot(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class World {
  readonly scene = new THREE.Scene();
  readonly targets: TargetObj[] = [];
  readonly raycastables: THREE.Object3D[] = [];
  private flags: Flag[] = [];
  private trees!: THREE.InstancedMesh;
  private treeBase: { rs: THREE.Matrix4; pos: THREE.Vector3; down: number; phase: number }[] = [];
  private puffs: Puff[] = [];
  private tracers: Tracer[] = [];
  private dot = softDot();
  private flashes: { sprite: THREE.Sprite; born: number }[] = [];
  private signs: THREE.Sprite[] = [];
  private marker: THREE.Sprite;

  constructor(readonly range: RangeDef, humidity: number) {
    this.buildSky(humidity);
    this.buildTerrain();
    this.buildTargets();
    this.buildFlags();
    this.buildTrees();
    this.marker = markerSprite();
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  /** Point out the current drill target with a marker above it (null hides it). */
  setMarker(tg: TargetObj | null) {
    this.marker.visible = !!tg;
    if (!tg) return;
    const size = 0.22 + (tg.def.rangeM / 1500) * 0.5;
    this.marker.scale.set(size, size, 1);
    this.marker.position.copy(tg.center).add(new THREE.Vector3(0, tg.halfHeight + 0.3 + size, 0));
  }

  setSignsVisible(v: boolean) {
    for (const sg of this.signs) sg.visible = v;
  }

  private buildSky(humidity: number) {
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = 4 + humidity * 6;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(35));
    u.sunPosition.value.copy(sun);
    this.scene.add(sky);
    const haze = new THREE.Color().setHSL(0.58, 0.25, 0.72 + humidity * 0.08);
    this.scene.fog = new THREE.FogExp2(haze, 0.00006 + humidity * 0.00008);
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a5230, 1.4));
    const dir = new THREE.DirectionalLight(0xfff3dc, 2.2);
    dir.position.copy(sun).multiplyScalar(1000);
    this.scene.add(dir);
  }

  private buildTerrain() {
    // Non-uniform grid: dense in the shooting lane, sparse in the surrounding hills.
    const xs: number[] = [];
    for (let x = -2000; x < -LANE_HALF_WIDTH_M - 40; x += 40) xs.push(x);
    for (let x = -LANE_HALF_WIDTH_M - 40; x <= LANE_HALF_WIDTH_M + 40; x += 4) xs.push(x);
    for (let x = LANE_HALF_WIDTH_M + 80; x <= 2000; x += 40) xs.push(x);
    const ds: number[] = [];
    for (let d = -300; d < 0; d += 20) ds.push(d);
    for (let d = 0; d <= 1700; d += 4) ds.push(d);
    for (let d = 1720; d <= 4000; d += 40) ds.push(d);

    const nx = xs.length;
    const nd = ds.length;
    const pos = new Float32Array(nx * nd * 3);
    const col = new Float32Array(nx * nd * 3);
    const uv = new Float32Array(nx * nd * 2);
    const r = new Rand(11);
    const c = new THREE.Color();
    let k = 0;
    for (let j = 0; j < nd; j++) {
      for (let i = 0; i < nx; i++) {
        const right = xs[i];
        const down = ds[j];
        const h = groundHeight(down, right);
        pos[k * 3] = right;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = -down;
        uv[k * 2] = right / 6;
        uv[k * 2 + 1] = down / 6;
        const lane = Math.abs(right) < LANE_HALF_WIDTH_M ? 1 : 0;
        const dry = 0.5 + 0.5 * Math.sin(down / 230 + right / 170);
        c.setHSL(0.2 + 0.05 * dry - 0.02 * lane, 0.35 + 0.1 * r.uniform(), 0.32 + 0.05 * r.uniform() + 0.04 * dry);
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
        k++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < nd - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        // counter-clockwise seen from above (z decreases as j grows), so normals point up
        idx.push(a, b, d, b, e, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: noiseTexture(5, [200, 205, 190], 90) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "terrain";
    this.scene.add(mesh);
    this.raycastables.push(mesh);

    // Firing point mat
    const mat2 = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 6),
      new THREE.MeshLambertMaterial({ map: noiseTexture(8, [120, 110, 90], 40) }),
    );
    mat2.rotation.x = -Math.PI / 2;
    mat2.position.set(0, 0.01, 1.5);
    this.scene.add(mat2);
  }

  private buildTargets() {
    // Freshly painted white steel: a little self-light keeps it bright through the haze.
    const steel = new THREE.MeshLambertMaterial({ color: 0xf4f4f0, emissive: 0x3a3a38, side: THREE.DoubleSide });
    const post = new THREE.MeshLambertMaterial({ color: 0x6b5a45 });
    const paperMat = new THREE.MeshLambertMaterial({ map: paperTexture(), side: THREE.DoubleSide });
    for (const def of this.range.targets) {
      const ground = groundHeight(def.rangeM, def.rightM);
      const center = world({ down: def.rangeM, right: def.rightM, up: ground + def.standM });
      const { geo, halfHeight } = plateGeometry(def);
      const group = new THREE.Group();
      group.position.copy(center);
      group.lookAt(new THREE.Vector3(0, center.y, 0));

      const width = def.sizeM;
      const postH = def.standM + halfHeight + 0.15;
      const postGeo = new THREE.BoxGeometry(0.06, postH, 0.06);
      const meshes: THREE.Object3D[] = [];
      for (const sx of [-1, 1]) {
        const p = new THREE.Mesh(postGeo, post);
        p.position.set(sx * (width / 2 + 0.15), postH / 2 - def.standM, -0.1);
        group.add(p);
        meshes.push(p);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(width + 0.36, 0.05, 0.05), post);
      bar.position.set(0, halfHeight + 0.12, -0.1);
      group.add(bar);
      meshes.push(bar);

      const pivot = new THREE.Group();
      pivot.position.set(0, halfHeight + 0.08, 0);
      group.add(pivot);
      const plate = new THREE.Mesh(geo, def.shape === "paper" ? paperMat : steel);
      plate.position.set(0, -halfHeight - 0.08, 0);
      pivot.add(plate);
      const marks = new THREE.Group();
      marks.position.z = 0.003;
      plate.add(marks);
      meshes.push(plate);

      if (def.shape === "paper") {
        const board = new THREE.Mesh(new THREE.BoxGeometry(width + 0.1, width + 0.1, 0.02), post);
        board.position.z = -0.02;
        plate.add(board);
      }

      const sign = textSprite(String(def.rangeM));
      const signScale = Math.max(1, def.rangeM / 700);
      sign.scale.set(0.5 * signScale, 0.25 * signScale, 1);
      // At the foot of the stand on the outer side, clear of the lines of sight to other targets.
      const outer = def.rightM < 0 ? -1 : 1;
      sign.position.set(outer * (width / 2 + 0.3 + 0.25 * signScale), -def.standM + 0.13 * signScale, 0.05);
      group.add(sign);
      this.signs.push(sign);

      this.scene.add(group);
      group.updateMatrixWorld(true);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion).normalize();
      const rightV = new THREE.Vector3(0, 1, 0).cross(normal).normalize();
      const obj: TargetObj = { def, center, normal, right: rightV, pivot, plate, marks, halfHeight, swing: { amp: 0, t0: 0 }, meshes };
      for (const m of meshes) {
        m.userData.target = obj;
        this.raycastables.push(m);
      }
      this.targets.push(obj);
    }
  }

  private buildFlags() {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xd8d8d0 });
    const flagMat = new THREE.MeshLambertMaterial({ color: 0xe8592a, side: THREE.DoubleSide });
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.05, 6, 6);
    let phase = 0;
    for (const f of this.range.flags) {
      const g = groundHeight(f.rangeM, f.rightM);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.copy(world({ down: f.rangeM, right: f.rightM, up: g + 3 }));
      this.scene.add(pole);
      const geo = new THREE.PlaneGeometry(1.8, 0.9, 14, 4);
      geo.translate(0.9, -0.45, 0);
      const base = new Float32Array(geo.attributes.position.array as Float32Array);
      const group = new THREE.Group();
      group.position.copy(world({ down: f.rangeM, right: f.rightM, up: g + 5.95 }));
      const mesh = new THREE.Mesh(geo, flagMat);
      group.add(mesh);
      this.scene.add(group);
      this.flags.push({ group, geo, base, down: f.rangeM, heading: 0, speed: 0, phase: (phase += 1.7) });
    }
  }

  private buildTrees() {
    const r = new Rand(23);
    const geo = new THREE.ConeGeometry(2.2, 9, 7);
    geo.translate(0, 4.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0x2f4a26 });
    const count = 520;
    this.trees = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      let right = r.range(LANE_HALF_WIDTH_M + 25, 900) * (r.uniform() < 0.5 ? -1 : 1);
      const down = r.range(-150, 2200);
      if (down > 1600 && Math.abs(right) < 300) right *= 0.4 + r.uniform() * 0.4;
      const h = groundHeight(down, right) - 0.3;
      const s = r.range(0.7, 1.6);
      m.compose(
        new THREE.Vector3(right, h, -down),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r.range(0, 6.28), 0)),
        new THREE.Vector3(s, s * r.range(0.8, 1.3), s),
      );
      this.trees.setMatrixAt(i, m);
      const pos = new THREE.Vector3().setFromMatrixPosition(m);
      const rs = m.clone().setPosition(0, 0, 0);
      this.treeBase.push({ rs, pos, down, phase: r.range(0, 6.28) });
    }
    this.scene.add(this.trees);
  }

  /** windAt(down) -> [downrange, right] m/s at the current time */
  update(t: number, windAt: (down: number) => [number, number]) {
    // Flags
    for (const f of this.flags) {
      const [wd, wr] = windAt(f.down);
      const wx = wr;
      const wz = -wd;
      const speed = Math.hypot(wx, wz);
      const target = Math.atan2(-wz, wx);
      let dh = target - f.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      f.heading += dh * 0.06;
      f.speed += (speed - f.speed) * 0.05;
      f.group.rotation.y = f.heading;
      const lift = Math.min(1, f.speed / 7);
      const droop = (1 - lift) * 1.25 + 0.08;
      const pos = f.geo.attributes.position.array as Float32Array;
      const freq = 2 + f.speed * 1.6;
      for (let i = 0; i < pos.length; i += 3) {
        const u = f.base[i] / 1.8;
        const v = f.base[i + 1];
        const len = u * 1.8;
        const a = droop * (0.6 + 0.4 * u);
        const ripple = Math.sin(u * 7 - t * freq + f.phase) * 0.11 * u * (0.3 + lift);
        // rotate (len, v) by the droop angle about the hoist
        pos[i] = len * Math.cos(a) + v * Math.sin(a);
        pos[i + 1] = -len * Math.sin(a) + v * Math.cos(a);
        pos[i + 2] = ripple;
      }
      f.geo.attributes.position.needsUpdate = true;
      f.geo.computeVertexNormals();
    }

    // Trees lean and sway with the local wind
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let lastDown = NaN;
    let w: [number, number] = [0, 0];
    for (let i = 0; i < this.treeBase.length; i++) {
      const b = this.treeBase[i];
      const bucket = Math.round(b.down / 200) * 200;
      if (bucket !== lastDown) {
        w = windAt(Math.max(0, bucket));
        lastDown = bucket;
      }
      const amp = 0.0035 * Math.hypot(w[0], w[1]);
      const s = Math.sin(t * 1.3 + b.phase) * amp;
      e.set(-w[0] * 0.004 + s, 0, -w[1] * 0.004 + s * 0.5);
      q.setFromEuler(e);
      // world-space lean: translate * sway * (rotation * scale)
      m.makeRotationFromQuaternion(q).multiply(b.rs).setPosition(b.pos);
      this.trees.setMatrixAt(i, m);
    }
    this.trees.instanceMatrix.needsUpdate = true;

    // Plate swing (damped pendulum about the top hinge)
    for (const tg of this.targets) {
      if (tg.swing.amp <= 0) continue;
      const dt = t - tg.swing.t0;
      const omega = Math.sqrt(9.81 / Math.max(0.15, tg.halfHeight)) * 1.1;
      const a = tg.swing.amp * Math.exp(-dt * 1.4) * Math.sin(omega * dt);
      tg.pivot.rotation.x = -a;
      if (dt > 6) {
        tg.swing.amp = 0;
        tg.pivot.rotation.x = 0;
      }
    }

    // Dust puffs
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      const age = t - p.born;
      if (age > p.life) {
        this.scene.remove(p.points);
        p.points.geometry.dispose();
        (p.points.material as THREE.Material).dispose();
        this.puffs.splice(i, 1);
        continue;
      }
      const pos = p.points.geometry.attributes.position.array as Float32Array;
      for (let k = 0; k < pos.length; k += 3) {
        pos[k] += p.vel[k] * 0.016;
        pos[k + 1] += p.vel[k + 1] * 0.016;
        pos[k + 2] += p.vel[k + 2] * 0.016;
        p.vel[k + 1] -= 0.6 * 0.016;
      }
      p.points.geometry.attributes.position.needsUpdate = true;
      const mat = p.points.material as THREE.PointsMaterial;
      mat.opacity = 0.75 * (1 - age / p.life);
      mat.size = 0.35 + age * 0.5;
    }

    // Steel hit flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const age = t - f.born;
      if (age > 0.12) {
        this.scene.remove(f.sprite);
        this.flashes.splice(i, 1);
      } else {
        (f.sprite.material as THREE.SpriteMaterial).opacity = 1 - age / 0.12;
      }
    }

    // Bullet traces
    for (const tr of this.tracers) {
      if (tr.done) continue;
      const end = tr.times[tr.times.length - 1];
      const ft = Math.min(t - tr.t0, end);
      if (tr.impactAt === null && t - tr.t0 >= end) {
        tr.impactAt = t;
        tr.onDone();
      }
      // After impact the wake hangs for a moment, then fades.
      const fade = tr.impactAt === null ? 1 : 1 - (t - tr.impactAt) / 0.35;
      if (fade <= 0) {
        tr.done = true;
        this.scene.remove(tr.points);
        tr.points.geometry.dispose();
        continue;
      }
      // Distance travelled so far, measured along the path, sets how long the wake can be.
      const head = this.pathIndexAt(tr, ft);
      const pos = tr.points.geometry.attributes.position.array as Float32Array;
      const alpha = tr.points.geometry.attributes.aAlpha.array as Float32Array;
      const size = tr.points.geometry.attributes.aSize.array as Float32Array;
      const p = new THREE.Vector3();
      for (let i = 0; i < TRACE_POINTS; i++) {
        const idx = head - i * TRACE_SPACING_M;
        if (idx < 2) {
          alpha[i] = 0;
          continue;
        }
        const k = Math.floor(idx);
        p.copy(tr.path[k]).lerp(tr.path[Math.min(k + 1, tr.path.length - 1)], idx - k);
        pos[i * 3] = p.x;
        pos[i * 3 + 1] = p.y;
        pos[i * 3 + 2] = p.z;
        const u = i / TRACE_POINTS;
        // Hidden near the muzzle (blast, and far out of focus in the scope); fully visible by ~150 m.
        const range = Math.hypot(p.x, p.z);
        const nearFade = Math.min(1, Math.max(0, (range - 40) / 110));
        // Densest just behind the bullet, thinning and widening toward the tail.
        alpha[i] = tr.visibility * fade * nearFade * Math.pow(1 - u, 1.8) * (0.75 + 0.25 * Math.sin(i * 1.7 + t * 40));
        size[i] = 0.1 + 0.2 * u;
      }
      tr.points.geometry.attributes.position.needsUpdate = true;
      tr.points.geometry.attributes.aAlpha.needsUpdate = true;
      tr.points.geometry.attributes.aSize.needsUpdate = true;
    }
    this.tracers = this.tracers.filter((x) => !x.done);
  }

  /** Fractional index into the path (≈1 m per step) where the bullet is at flight time `ft`. */
  private pathIndexAt(tr: Tracer, ft: number): number {
    const ts = tr.times;
    let lo = 0;
    let hi = ts.length - 1;
    if (ft >= ts[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= ft) lo = mid;
      else hi = mid;
    }
    return lo + (ft - ts[lo]) / Math.max(1e-6, ts[hi] - ts[lo]);
  }

  private traceMaterial = new THREE.ShaderMaterial({
    vertexShader: traceVertex,
    fragmentShader: traceFragment,
    uniforms: { uHalfHeight: { value: 400 }, uColor: { value: new THREE.Color(0xe6ecef) } },
    transparent: true,
    depthWrite: false,
  });

  /** Drawing-buffer height in pixels, so the trace is sized correctly on screen. */
  setViewportHeight(px: number) {
    this.traceMaterial.uniforms.uHalfHeight.value = px / 2;
  }

  /**
   * Animate the bullet's trace along its path. `visibility` (0..1) sets how strongly the wake
   * shows (humid air shows it best). `onDone` fires when the bullet reaches the end.
   */
  launch(path: THREE.Vector3[], times: number[], t0: number, visibility: number, onDone: () => void) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRACE_POINTS * 3), 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(TRACE_POINTS), 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(TRACE_POINTS), 1));
    const points = new THREE.Points(geo, this.traceMaterial);
    points.frustumCulled = false;
    points.renderOrder = 2;
    this.scene.add(points);
    this.tracers.push({ points, path, times, t0, visibility, onDone, impactAt: null, done: false });
  }

  steelHit(tg: TargetObj, u: number, v: number, energyJ: number, t: number) {
    const area = tg.def.sizeM * tg.halfHeight * 2;
    tg.swing = { amp: Math.min(0.9, (energyJ / 2500) * (0.25 / Math.max(0.04, area)) * 0.35 + 0.05), t0: t };
    this.mark(tg, u, v, 0.022, 0x8b8f93);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xfff1c0, transparent: true, depthWrite: false }));
    flash.scale.setScalar(Math.max(0.25, tg.def.rangeM / 1500));
    flash.position.copy(tg.center).addScaledVector(tg.right, u).add(new THREE.Vector3(0, v, 0)).addScaledVector(tg.normal, 0.05);
    this.scene.add(flash);
    this.flashes.push({ sprite: flash, born: t });
  }

  paperHit(tg: TargetObj, u: number, v: number, holeRadius: number) {
    this.mark(tg, u, v, Math.max(0.004, holeRadius), 0x111111);
  }

  private mark(tg: TargetObj, u: number, v: number, r: number, color: number) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 12), new THREE.MeshBasicMaterial({ color }));
    // plate local frame: x right, y up, origin at the plate centre
    m.position.set(u, v, 0);
    tg.marks.add(m);
  }

  clearMarks() {
    for (const tg of this.targets) tg.marks.clear();
  }

  dust(point: THREE.Vector3, size: number, wind: THREE.Vector3, t: number) {
    const r = new Rand(Math.floor(t * 1000));
    const n = 50;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = point.x + r.range(-0.15, 0.15) * size;
      pos[i * 3 + 1] = point.y + r.range(0, 0.2) * size;
      pos[i * 3 + 2] = point.z + r.range(-0.15, 0.15) * size;
      vel[i * 3] = r.range(-0.8, 0.8) * size + wind.x * 0.7;
      vel[i * 3 + 1] = r.range(0.6, 2.4) * size;
      vel[i * 3 + 2] = r.range(-0.8, 0.8) * size + wind.z * 0.7;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.35,
      map: this.dot,
      color: 0xb39b72,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this.puffs.push({ points, vel, born: t, life: 2.8 });
  }
}
