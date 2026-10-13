import type { Info, Pair } from "./model.ts";
import type { Place } from "./nav.ts";

import { PLAN, coupledWith, isNode, isZone, node, zone } from "./plan.ts";
import { esc } from "./svg.ts";

export function chip(id: string): string {
  let item: { readonly color: string; readonly label: string } | null = null;

  if (isNode(id)) {
    item = { color: node(id).color, label: node(id).label };
  } else if (isZone(id)) {
    item = { color: zone(id).color, label: zone(id).title };
  }

  if (item === null) {
    return "";
  }

  return `<button type="button" class="chip" data-go="${id}" style="--zc: var(${item.color})"><span class="dot"></span>${esc(item.label.replaceAll("\n", " "))}</button>`;
}

const pairs = (items: readonly Pair[], escape: boolean): string =>
  items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${escape ? esc(v) : v}</dd>`).join("");

const list = (items: readonly string[], escape: boolean): string =>
  items.map((i) => `<li>${escape ? esc(i) : i}</li>`).join("");

function replaceSection(info: Info, coupled: readonly string[]): string {
  if (info.swap === undefined && coupled.length === 0) {
    return "";
  }

  const swap = info.swap === undefined ? "" : `<p>${info.swap}</p>`;

  const chips =
    coupled.length === 0
      ? ""
      : `<p class="label">Change avec, entouré sur le plan :</p><div class="chips">${coupled.map(chip).join("")}</div>`;

  return `<h3>Pour remplacer</h3>${swap}${chips}`;
}

function laterSections(info: Info): string {
  return [
    info.extend === undefined ? "" : `<h3>Pour étendre</h3><p>${info.extend}</p>`,
    info.why === undefined || info.why.length === 0 ? "" : `<h3>Pourquoi</h3><ul>${list(info.why, false)}</ul>`,
    info.alt === undefined ? "" : `<h3>Écarté ou reporté</h3><p class="alt">${info.alt}</p>`,
    info.facts === undefined ? "" : `<h3>Repères</h3><dl class="facts">${pairs(info.facts, false)}</dl>`,
    info.warn === undefined ? "" : `<h3>Point ouvert</h3><p class="warn">${info.warn}</p>`,
    info.how === undefined ? "" : `<h3>Lecture</h3><p>${info.how}</p>`,
  ].join("");
}

export function renderInfo(
  info: Info,
  color: string,
  extra: string,
  coupled: readonly string[],
  brief: readonly string[],
): string {
  return [
    `<div style="--zc: var(${color})">`,
    info.kicker === undefined ? "" : `<p class="kicker">${esc(info.kicker)}</p>`,
    `<h2><span class="swatch"></span>${info.title}</h2>`,
    info.lead === undefined ? "" : `<p class="lead">${info.lead}</p>`,
    brief.length === 0 ? "" : `<ul class="brief">${list(brief, true)}</ul>`,
    info.io === undefined ? "" : `<h3>Contrat</h3><dl class="facts io">${pairs(info.io, false)}</dl>`,
    replaceSection(info, coupled),
    laterSections(info),
    extra,
    info.see === undefined || info.see.length === 0
      ? ""
      : `<h3>Voir aussi</h3><div class="chips">${info.see.map(chip).join("")}</div>`,
    info.src === undefined ? "" : `<p class="src">Source : ${esc(info.src)}</p>`,
    "</div>",
  ].join("");
}

function zoneTour(zid: string): string {
  const order = PLAN.zoneOrder;
  const i = order.indexOf(zid);
  const prev = zone(order[(i + order.length - 1) % order.length] ?? zid);
  const next = zone(order[(i + 1) % order.length] ?? zid);

  return `<div class="nav"><button type="button" data-go="${prev.id}">← ${esc(prev.title)}</button><button type="button" data-go="${next.id}">${esc(next.title)} →</button></div>`;
}

export function renderPanel(panel: HTMLElement, place: Place): void {
  if (place.node !== null) {
    const n = node(place.node);

    const up =
      n.zone === null
        ? ""
        : `<div class="nav"><button type="button" data-go="${n.zone}">↑ ${esc(zone(n.zone).title)}</button></div>`;

    panel.innerHTML = renderInfo(n.info, n.color, "", coupledWith(n.id), []) + up;
  } else if (place.zone === null) {
    const zones = `<h3>Zones</h3><div class="chips">${PLAN.zoneOrder.map(chip).join("")}</div>`;
    panel.innerHTML = renderInfo(PLAN.overview, "--accent", zones, [], []);
  } else {
    const z = zone(place.zone);
    panel.innerHTML = renderInfo(z.info, z.color, "", [], z.kw) + zoneTour(z.id);
  }

  panel.scrollTop = 0;
}

export function renderCrumbs(crumbs: HTMLElement, place: Place): void {
  const current = 'aria-current="true"';

  const parts = [
    `<button type="button" data-go="" ${place.zone === null && place.node === null ? current : ""}>Plan</button>`,
  ];

  if (place.zone !== null) {
    const title = esc(zone(place.zone).title);
    parts.push(
      `<span class="sep">›</span><button type="button" data-go="${place.zone}" ${place.node === null ? current : ""}>${title}</button>`,
    );
  }

  if (place.node !== null) {
    parts.push(`<span class="sep">›</span><button type="button" ${current}>${esc(node(place.node).label)}</button>`);
  }

  crumbs.innerHTML = parts.join("");
}
