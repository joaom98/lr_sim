// Small SVG charts: single-series line charts with a crosshair shared across charts, and a
// group (impact) plot. Colors come from CSS tokens so light/dark themes swap in one place.

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** "Nice" tick values covering [lo, hi]. */
export function ticks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10 || v === 0) return String(+v.toFixed(1));
  return String(+v.toFixed(2));
}

export interface LineChartSpec {
  title: string;
  unit: string;
  xs: number[];
  ys: number[];
  xUnit: string;
  yDigits: number;
  /** Horizontal reference line, e.g. Mach 1 on a velocity chart. */
  refY?: { value: number; label: string };
  /** Vertical reference line, e.g. where the bullet goes subsonic. */
  refX?: { value: number; label: string };
}

type HoverBus = { listeners: ((i: number | null) => void)[] };

export function createHoverBus(): HoverBus {
  return { listeners: [] };
}

export function lineChart(host: HTMLElement, spec: LineChartSpec, bus: HoverBus) {
  host.replaceChildren();
  const W = Math.max(260, host.clientWidth || 320);
  const H = 190;
  const m = { l: 46, r: 12, t: 26, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const xMax = spec.xs[spec.xs.length - 1] ?? 1;
  let yLo = Math.min(...spec.ys, spec.refY?.value ?? Infinity);
  let yHi = Math.max(...spec.ys, spec.refY?.value ?? -Infinity);
  if (yLo > 0 && yLo < yHi * 0.5) yLo = 0;
  if (yHi < 0 && yHi > yLo * 0.5) yHi = 0;
  if (yHi - yLo < 1e-9) {
    yHi += 1;
    yLo -= 1;
  }
  const yt = ticks(yLo, yHi, 4);
  yLo = Math.min(yLo, yt[0]);
  yHi = Math.max(yHi, yt[yt.length - 1]);
  const X = (v: number) => m.l + (v / xMax) * iw;
  const Y = (v: number) => m.t + (1 - (v - yLo) / (yHi - yLo)) * ih;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${spec.title} chart` });
  svg.classList.add("chart");

  const title = el("text", { x: m.l, y: 15, class: "chart-title" });
  title.textContent = `${spec.title} (${spec.unit})`;
  svg.append(title);

  for (const v of yt) {
    svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? "axis" : "grid" }));
    const t = el("text", { x: m.l - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" });
    t.textContent = fmtTick(v);
    svg.append(t);
  }
  for (const v of ticks(0, xMax, 5)) {
    const t = el("text", { x: X(v), y: H - 9, class: "tick", "text-anchor": "middle" });
    t.textContent = v === 0 ? `0 ${spec.xUnit}` : fmtTick(v);
    svg.append(t);
  }

  if (spec.refX && spec.refX.value <= xMax) {
    svg.append(el("line", { x1: X(spec.refX.value), x2: X(spec.refX.value), y1: m.t, y2: m.t + ih, class: "ref" }));
    const t = el("text", { x: X(spec.refX.value) + 4, y: m.t + 10, class: "ref-label" });
    t.textContent = spec.refX.label;
    svg.append(t);
  }
  if (spec.refY) {
    svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(spec.refY.value), y2: Y(spec.refY.value), class: "ref" }));
    const t = el("text", { x: W - m.r, y: Y(spec.refY.value) - 4, class: "ref-label", "text-anchor": "end" });
    t.textContent = spec.refY.label;
    svg.append(t);
  }

  const d = spec.xs.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(spec.ys[i]).toFixed(1)}`).join("");
  svg.append(el("path", { d, class: "series" }));

  // Hover layer: crosshair + dot + readout, synchronized through the bus.
  const cross = el("line", { y1: m.t, y2: m.t + ih, class: "crosshair", visibility: "hidden" });
  const dot = el("circle", { r: 4.5, class: "hover-dot", visibility: "hidden" });
  const readout = el("text", { x: W - m.r, y: 15, class: "readout", "text-anchor": "end" });
  svg.append(cross, dot, readout);
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
  svg.append(hit);

  const show = (i: number | null) => {
    if (i === null || i >= spec.xs.length) {
      cross.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
      readout.textContent = "";
      return;
    }
    const x = X(spec.xs[i]);
    const y = Y(spec.ys[i]);
    cross.setAttribute("x1", String(x));
    cross.setAttribute("x2", String(x));
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("visibility", "visible");
    readout.textContent = `${spec.xs[i].toFixed(0)} ${spec.xUnit}: ${spec.ys[i].toFixed(spec.yDigits)} ${spec.unit}`;
  };
  bus.listeners.push(show);
  const pick = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const xv = ((px - m.l) / iw) * xMax;
    let best = 0;
    for (let i = 1; i < spec.xs.length; i++) if (Math.abs(spec.xs[i] - xv) < Math.abs(spec.xs[best] - xv)) best = i;
    bus.listeners.forEach((f) => f(best));
  };
  hit.addEventListener("pointermove", pick);
  hit.addEventListener("pointerdown", pick);
  hit.addEventListener("pointerleave", () => bus.listeners.forEach((f) => f(null)));

  host.append(svg);
}

export interface GroupPlotSpec {
  /** impacts in display angular units relative to point of aim (x right, y up) */
  points: { x: number; y: number; label: string }[];
  center: { x: number; y: number };
  unit: string;
  /** grid spacing in display units */
  gridStep: number;
}

export function groupPlot(host: HTMLElement, spec: GroupPlotSpec) {
  host.replaceChildren();
  const S = Math.min(320, Math.max(220, host.clientWidth || 280));
  const pad = 28;
  const extent =
    Math.max(spec.gridStep * 2, ...spec.points.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)])) * 1.15;
  const P = (v: number) => pad + ((v + extent) / (2 * extent)) * (S - 2 * pad);
  const Q = (v: number) => pad + ((extent - v) / (2 * extent)) * (S - 2 * pad);

  const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: "img", "aria-label": "Group impacts" });
  svg.classList.add("chart");
  let step = spec.gridStep;
  while (extent / step > 6) step *= 2;
  for (let v = -Math.floor(extent / step) * step; v <= extent; v += step) {
    const cls = Math.abs(v) < 1e-9 ? "axis" : "grid";
    svg.append(el("line", { x1: P(v), x2: P(v), y1: pad, y2: S - pad, class: cls }));
    svg.append(el("line", { y1: Q(v), y2: Q(v), x1: pad, x2: S - pad, class: cls }));
    if (Math.abs(v) > 1e-9) {
      const t = el("text", { x: P(v), y: S - pad + 14, class: "tick", "text-anchor": "middle" });
      t.textContent = fmtTick(v);
      svg.append(t);
    }
  }
  const u = el("text", { x: S - pad, y: pad - 8, class: "tick", "text-anchor": "end" });
  u.textContent = `${spec.unit}, from point of aim`;
  svg.append(u);
  const tip = el("text", { x: pad, y: pad - 8, class: "readout" });
  svg.append(tip);

  // Group centre marker
  const c = el("g", { class: "center-mark" });
  c.append(el("line", { x1: P(spec.center.x) - 6, x2: P(spec.center.x) + 6, y1: Q(spec.center.y), y2: Q(spec.center.y) }));
  c.append(el("line", { x1: P(spec.center.x), x2: P(spec.center.x), y1: Q(spec.center.y) - 6, y2: Q(spec.center.y) + 6 }));
  svg.append(c);

  for (const p of spec.points) {
    const dot = el("circle", { cx: P(p.x), cy: Q(p.y), r: 5, class: "impact" });
    const hit = el("circle", { cx: P(p.x), cy: Q(p.y), r: 11, fill: "transparent" });
    const on = () => {
      tip.textContent = p.label;
      dot.classList.add("hot");
    };
    const off = () => {
      tip.textContent = "";
      dot.classList.remove("hot");
    };
    hit.addEventListener("pointerenter", on);
    hit.addEventListener("pointerdown", on);
    hit.addEventListener("pointerleave", off);
    svg.append(dot, hit);
  }
  host.append(svg);
}
