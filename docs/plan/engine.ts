import type { Rect } from "./camera.ts";
import type { MachineDrawing, MachineEvent, Player } from "./machines.ts";
import type { MapDrawing } from "./map.ts";
import type { Machine } from "./model.ts";
import type { NavEvent, Place } from "./nav.ts";
import type { Overview } from "./overview.ts";

import { MACHINES } from "./data-machines.ts";
import { drawMachine, freshPlayer, highlightMachine, neighbourhood, play, renderMachinePanel } from "./machines.ts";
import { drawMap } from "./map.ts";
import { fontKey } from "./measure.ts";
import { HOME, navigate } from "./nav.ts";
import { drawOverview } from "./overview.ts";
import { renderCrumbs, renderPanel } from "./panel.ts";
import { OWN, PLAN, coupledWith, isNode, isZone, nestsZone, zoneOfNode } from "./plan.ts";
import { mountFlow, mountGate, mountGuards, mountLearn, mountReview, mountVerify } from "./product.ts";
import { Sheet, union } from "./sheet.ts";
import { defs, el, esc, setMarker } from "./svg.ts";

type View = "produit" | "mecanique" | "architecture";

const VIEWS: readonly View[] = ["produit", "mecanique", "architecture"];

const isView = (s: string): s is View => VIEWS.some((v) => v === s);

function byId<E extends Element>(id: string, kind: new () => E): E {
  const e = document.getElementById(id);

  if (!(e instanceof kind)) {
    throw new TypeError(`page.html : #${id} manque ou n'est pas un ${kind.name}`);
  }

  return e;
}

// ---------- the architecture ----------
// Two drawings share the sheet: the overview, where the plan opens, and the
// detail of every brick and arrow. The place decides which one shows and
// where the camera frames; a switch between them fades, a move inside one pans.
const mapSheet = new Sheet(byId("map", SVGSVGElement));

const panel = byId("panel", HTMLElement);

const crumbs = byId("crumbs", HTMLElement);

type Drawn = {
  readonly ov: Overview;
  readonly dt: MapDrawing;
  readonly ovLayer: SVGGElement;
  readonly dtLayer: SVGGElement;
};

let drawn: Drawn | null = null;

// Bumped by a rebuild: a drawing started before it lands on a detached layer and is dropped.
let generation = 0;

let fontsReady: Promise<void> | null = null;

async function ensureFonts(): Promise<void> {
  fontsReady ??= (async (): Promise<void> => {
    const text = shownText();
    await Promise.all(FACES.map(async (f) => document.fonts.load(f, text)));
    await document.fonts.ready;
  })();

  await fontsReady;
}

let place: Place = HOME;

let mapBuilding: Promise<void> | null = null;

const onOverview = (p: Place): boolean => p.zone === null;

function mapFrame(p: Place): Rect {
  if (drawn === null) {
    return { x: 0, y: 0, w: 10, h: 10 };
  }

  if (p.zone === null) {
    return mapSheet.frame({ x: 0, y: 0, w: drawn.ov.size.w, h: drawn.ov.size.h }, 10);
  }

  const key = nestsZone(p.zone) ? p.zone + OWN : p.zone;
  const r = drawn.dt.rects.get(key);

  if (r === undefined) {
    throw new Error(`plan : aucun cadre pour ${p.zone}`);
  }

  return mapSheet.frame(r, 16);
}

function highlightMap(p: Place): void {
  if (drawn === null) {
    return;
  }

  const coupled = p.node === null ? [] : coupledWith(p.node);

  for (const d of [drawn.ov, drawn.dt]) {
    for (const [id, gs] of d.zoneEls) {
      for (const g of gs) {
        g.classList.toggle("focused", id === p.zone);
      }
    }

    for (const [id, gs] of d.nodeEls) {
      for (const g of gs) {
        g.classList.toggle("selected", id === p.node);
        g.classList.toggle("coupled", coupled.includes(id));
      }
    }

    for (const e of d.arrows) {
      const hot = p.node !== null && (e.from === p.node || e.to === p.node);
      e.g.classList.toggle("hot", hot);
      setMarker(e, hot ? "url(#map-arr-hot)" : e.marker);
    }
  }

  drawn.ovLayer.classList.toggle("off", !onOverview(p));
  drawn.dtLayer.classList.toggle("off", onOverview(p));
}

function renderMap(): void {
  renderPanel(panel, place);
  renderCrumbs(crumbs, place);
  highlightMap(place);
}

function sendMap(ev: NavEvent): void {
  const before = place;
  place = navigate(place, ev, zoneOfNode);

  if (onOverview(before) === onOverview(place)) {
    mapSheet.go(mapFrame(place));
  } else {
    mapSheet.jump(mapFrame(place));
  }

  renderMap();
  setHash(place.node ?? place.zone ?? "architecture");
}

async function buildMap(): Promise<void> {
  const gen = generation;
  await ensureFonts();
  const svg = mapSheet.svg;
  svg.replaceChildren();
  defs(svg, "map");
  const grid = el("rect", { fill: "url(#map-grid)" }, svg);
  const ovLayer = el("g", { class: "layer" }, svg);
  const dtLayer = el("g", { class: "layer off" }, svg);
  const ov = await drawOverview(ovLayer, sendMap);
  const dt = await drawMap(dtLayer, sendMap);

  if (gen !== generation) {
    return;
  }

  const w = Math.max(ov.size.w, dt.size.w);
  const h = Math.max(ov.size.h, dt.size.h);
  grid.setAttribute("x", String(-w));
  grid.setAttribute("y", String(-h));
  grid.setAttribute("width", String(w * 3));
  grid.setAttribute("height", String(h * 3));
  drawn = { ov, dt, ovLayer, dtLayer };
  byId("map-loading", HTMLElement).hidden = true;
  mapSheet.jump(mapFrame(place));
  renderMap();
}

async function ensureMap(): Promise<void> {
  mapBuilding ??= buildMap().catch(failIn(panel));

  await mapBuilding;
}

// ---------- the machines ----------
const machineSheet = new Sheet(byId("machine-map", SVGSVGElement));

const machinePanel = byId("machine-panel", HTMLElement);

const machineList = byId("machine-list", HTMLElement);

type MachineLayer = { readonly layer: SVGGElement; readonly drawing: MachineDrawing };

const drawings = new Map<string, MachineLayer>();

const pendingDraws = new Map<string, Promise<MachineLayer>>();

async function drawFresh(m: Machine): Promise<MachineLayer> {
  await ensureFonts();
  const layer = el("g", {}, machineSheet.svg);
  layer.style.display = "none";
  const drawing = await drawMachine(layer, m, sendMachine);

  return { layer, drawing };
}

let machine: Machine | null = null;

let player: Player | null = null;

function machineOf(id: string): Machine | null {
  return MACHINES.find((m) => m.id === id) ?? null;
}

const READABLE_SCALE = 0.8;

function machineFrame(d: MachineDrawing, m: Machine, p: Player, follow: boolean): Rect {
  const all = machineSheet.frame({ x: 0, y: 0, w: d.size.w, h: d.size.h }, 10);
  const scale = machineSheet.svg.getBoundingClientRect().width / all.w;

  if (!follow || scale >= READABLE_SCALE) {
    return all;
  }

  const u = union(neighbourhood(d, m, p));
  const grown = { x: u.x - 60, y: u.y - 40, w: u.w + 120, h: u.h + 80 };
  const minW = Math.min(all.w, 760);

  return machineSheet.frame(grown.w >= minW ? grown : { ...grown, x: grown.x - (minW - grown.w) / 2, w: minW }, 0);
}

let followPlayer = true;

function renderMachine(): void {
  if (machine === null || player === null) {
    return;
  }

  const d = drawings.get(machine.id);

  if (d !== undefined) {
    highlightMachine(d.drawing, machine, player);
    machineSheet.go(machineFrame(d.drawing, machine, player, followPlayer));
  }

  renderMachinePanel(machinePanel, machine, player);

  for (const b of machineList.querySelectorAll<HTMLButtonElement>("[data-machine]")) {
    b.setAttribute("aria-current", b.dataset["machine"] === machine.id ? "true" : "false");
  }
}

function sendMachine(ev: MachineEvent): void {
  if (machine === null || player === null) {
    return;
  }

  player = play(machine, player, ev);
  followPlayer = true;
  renderMachine();
}

async function showMachine(m: Machine): Promise<void> {
  machine = m;
  player = freshPlayer(m);
  setHash(m.id);

  for (const d of drawings.values()) {
    d.layer.style.display = "none";
  }

  const gen = generation;
  let d = drawings.get(m.id);

  if (d === undefined) {
    byId("machine-loading", HTMLElement).hidden = false;
    let p = pendingDraws.get(m.id);

    if (p === undefined) {
      p = drawFresh(m).finally(() => {
        pendingDraws.delete(m.id);
      });
      pendingDraws.set(m.id, p);
    }

    d = await p;

    if (gen !== generation) {
      return;
    }

    drawings.set(m.id, d);
    byId("machine-loading", HTMLElement).hidden = pendingDraws.size === 0;
  }

  if (machine !== m) {
    return;
  }

  d.layer.style.display = "";
  machineSheet.jump(machineSheet.frame({ x: 0, y: 0, w: d.drawing.size.w, h: d.drawing.size.h }, 10));
  followPlayer = true;
  renderMachine();
}

function pickMachine(m: Machine): void {
  void showMachine(m).catch(failIn(machinePanel));
}

function initMachines(): void {
  defs(machineSheet.svg, "mc");

  machineList.innerHTML = MACHINES.map(
    (m) => `<button type="button" class="chip" data-machine="${m.id}" aria-current="false">${esc(m.title)}</button>`,
  ).join("");

  machineList.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-machine]") : null;
    const m = b instanceof HTMLElement ? machineOf(b.dataset["machine"] ?? "") : null;

    if (m !== null) {
      pickMachine(m);
    }
  });

  byId("btn-machine-all", HTMLButtonElement).addEventListener("click", () => {
    followPlayer = false;
    renderMachine();
  });

  machinePanel.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const fire = t?.closest("[data-fire]");

    if (fire instanceof HTMLElement) {
      sendMachine({ type: "transition", id: fire.dataset["fire"] ?? "" });

      return;
    }

    if (t?.closest("[data-reset]") !== null && t?.closest("[data-reset]") !== undefined && machine !== null) {
      player = freshPlayer(machine);
      renderMachine();
    }
  });
}

// ---------- views and the hash ----------
let view: View = "produit";

let quietHash = false;

function setHash(token: string): void {
  quietHash = true;
  history.replaceState(null, "", `#${token}`);
  quietHash = false;
}

function show(v: View): void {
  view = v;

  for (const name of VIEWS) {
    byId(`view-${name}`, HTMLElement).hidden = name !== v;
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs [data-view]")) {
    b.setAttribute("aria-selected", b.dataset["view"] === v ? "true" : "false");
  }

  if (v === "architecture") {
    void ensureMap().then(() => {
      if (drawn !== null) {
        mapSheet.jump(mapFrame(place));
      }
    });
  }

  if (v === "mecanique" && machine === null) {
    const first = MACHINES[0];

    if (first !== undefined) {
      pickMachine(first);
    }
  } else if (v === "mecanique") {
    renderMachine();
  }
}

function openToken(token: string): void {
  if (isView(token)) {
    show(token);
    setHash(token);
  } else if (isZone(token) || isNode(token)) {
    place = navigate(HOME, isZone(token) ? { type: "zone", id: token } : { type: "node", id: token }, zoneOfNode);
    show("architecture");
    void ensureMap().then(() => {
      mapSheet.jump(mapFrame(place));
      renderMap();
    });
    setHash(token);
  } else if (machineOf(token) !== null) {
    const m = machineOf(token);

    if (m !== null) {
      pickMachine(m);
    }

    show("mecanique");
  } else if (token.startsWith("p-") && document.getElementById(token) !== null) {
    show("produit");
    document.getElementById(token)?.scrollIntoView({ block: "start" });
  } else {
    show("produit");
  }
}

function tokenOf(v: View): string {
  if (v === "architecture") {
    return place.node ?? place.zone ?? v;
  }

  if (v === "mecanique" && machine !== null) {
    return machine.id;
  }

  return v;
}

function initViews(): void {
  byId("tabs", HTMLElement).addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-view]") : null;
    const v = b instanceof HTMLElement ? (b.dataset["view"] ?? "") : "";

    if (isView(v)) {
      show(v);
      setHash(tokenOf(v));
    }
  });

  window.addEventListener("hashchange", () => {
    if (!quietHash) {
      openToken(location.hash.slice(1));
    }
  });

  document.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-go]") : null;

    if (b instanceof HTMLElement && (panel.contains(b) || crumbs.contains(b))) {
      const id = b.dataset["go"] ?? "";

      if (id === "") {
        sendMap({ type: "home" });
      } else if (isZone(id)) {
        sendMap({ type: "zone", id });
      } else if (isNode(id)) {
        sendMap({ type: "node", id });
      }
    }
  });

  byId("btn-home", HTMLButtonElement).addEventListener("click", () => {
    sendMap({ type: "home" });
  });

  mapSheet.svg.addEventListener("click", () => {
    if (place.zone !== null || place.node !== null) {
      sendMap({ type: "home" });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && view === "architecture" && (place.zone !== null || place.node !== null)) {
      sendMap({ type: "back" });
    }
  });

  // Only a sheet whose own size changed re-frames: a panel that grows on a phone must not cut a camera move short.
  const sizes = new WeakMap<Element, string>();

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const key = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;

      if (sizes.get(entry.target) === key) {
        continue;
      }

      sizes.set(entry.target, key);

      if (entry.target === mapSheet.svg && view === "architecture" && drawn !== null) {
        mapSheet.jump(mapFrame(place));
      }

      if (entry.target === machineSheet.svg && view === "mecanique" && machine !== null && player !== null) {
        const d = drawings.get(machine.id);

        if (d !== undefined) {
          machineSheet.jump(machineFrame(d.drawing, machine, player, followPlayer));
        }
      }
    }
  });

  observer.observe(mapSheet.svg);
  observer.observe(machineSheet.svg);
}

function fail(host: HTMLElement, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  host.innerHTML = `<p class="warn">Le dessin n'a pas pu se faire : <code>${esc(message)}</code></p>`;
  console.error(cause);
}

const failIn =
  (host: HTMLElement) =>
  (cause: unknown): void => {
    fail(host, cause);
  };

// ---------- start ----------
// Google Fonts splits each weight into subsets fetched on first use, so each
// face is loaded with the text the page draws before anything is measured.
const FACES = ['600 16px "Barlow Condensed"', '700 16px "Barlow Condensed"', '400 12px "IBM Plex Mono"'];

const shownText = (): string =>
  [
    ...new Set(
      [
        ...PLAN.nodes.flatMap((n) => [n.label, n.sub]),
        ...PLAN.zones.flatMap((z) => [z.title.toUpperCase(), z.tag]),
        ...PLAN.edges.map((e) => e.label),
        ...MACHINES.flatMap((m) => m.states.flatMap((s) => [s.label, s.sub ?? ""])),
        ...MACHINES.flatMap((m) => m.transitions.map((t) => t.event)),
      ].join(""),
    ),
  ].join("");

let builtFonts = "";

async function rebuild(): Promise<void> {
  generation += 1;
  builtFonts = fontKey();
  await mountFlow();
  drawings.clear();
  pendingDraws.clear();
  machineSheet.svg.replaceChildren();
  defs(machineSheet.svg, "mc");

  if (machine !== null) {
    pickMachine(machine);
  }

  if (mapBuilding !== null) {
    mapBuilding = null;
    await ensureMap();
  }
}

async function start(): Promise<void> {
  mountGuards();
  mountGate();
  mountVerify();
  mountLearn();
  mountReview();
  initMachines();
  initViews();
  openToken(location.hash.slice(1));
  await ensureFonts();
  builtFonts = fontKey();
  await mountFlow();

  document.fonts.addEventListener("loadingdone", () => {
    if (fontKey() !== builtFonts) {
      rebuild().catch(failIn(byId("steptext", HTMLElement)));
    }
  });
}

start().catch(failIn(byId("steptext", HTMLElement)));
