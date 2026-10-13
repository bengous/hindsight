import type { Flow, Machine, Plan } from "./model.ts";

import { OVERVIEW_FLOWS } from "./data-edges.ts";
import { MACHINES } from "./data-machines.ts";
import { FLOW } from "./data-product.ts";
import { PLAN } from "./plan.ts";

type Ids = { readonly nodes: Set<string>; readonly zones: Set<string> };

function checkIds(p: Plan, errors: string[]): Ids {
  const nodes = new Set<string>();
  const zones = new Set<string>();

  for (const n of p.nodes) {
    if (nodes.has(n.id)) {
      errors.push(`brique en double : ${n.id}`);
    }

    nodes.add(n.id);
  }

  for (const z of p.zones) {
    if (zones.has(z.id)) {
      errors.push(`zone en double : ${z.id}`);
    }

    zones.add(z.id);
  }

  return { nodes, zones };
}

function checkZones(p: Plan, zones: Set<string>, errors: string[]): void {
  for (const z of p.zones) {
    if (z.parent !== undefined && !zones.has(z.parent)) {
      errors.push(`zone ${z.id} : parent inconnu ${z.parent}`);
    }

    if (!p.zoneOrder.includes(z.id)) {
      errors.push(`zone ${z.id} absente de zoneOrder`);
    }
  }

  for (const id of p.zoneOrder) {
    if (!zones.has(id)) {
      errors.push(`zoneOrder : zone inconnue ${id}`);
    }
  }
}

function checkBricks(p: Plan, nodes: Set<string>, zones: Set<string>, errors: string[]): void {
  for (const n of p.nodes) {
    if (n.zone !== null && !zones.has(n.zone)) {
      errors.push(`brique ${n.id} : zone inconnue ${n.zone}`);
    }

    if (n.zone === null && n.side === undefined) {
      errors.push(`brique ${n.id} : une brique hors zone a besoin d'un side`);
    }

    for (const c of n.couples) {
      if (!nodes.has(c)) {
        errors.push(`brique ${n.id} : couplage vers une brique inconnue ${c}`);
      }
    }
  }
}

function checkEdges(p: Plan, nodes: Set<string>, zones: Set<string>, errors: string[]): void {
  for (const e of p.edges) {
    for (const end of [e.from, e.to]) {
      if (!nodes.has(end)) {
        errors.push(`flèche ${e.from} → ${e.to} : bout inconnu ${end}`);
      }
    }
  }

  for (const info of [p.overview, ...p.zones.map((z) => z.info), ...p.nodes.map((n) => n.info)]) {
    for (const id of info.see ?? []) {
      if (!nodes.has(id) && !zones.has(id)) {
        errors.push(`${info.title} : voir aussi inconnu ${id}`);
      }
    }
  }
}

function rootBoxOf(p: Plan, brickId: string): string {
  const zones = new Map(p.zones.map((z) => [z.id, z]));
  let zid = p.nodes.find((n) => n.id === brickId)?.zone ?? null;

  if (zid === null) {
    return brickId;
  }

  for (let parent = zones.get(zid)?.parent; parent !== undefined; parent = zones.get(zid)?.parent) {
    zid = parent;
  }

  return zid;
}

function checkFlows(p: Plan, errors: string[]): void {
  const boxes = new Set([
    ...p.zones.filter((z) => z.parent === undefined).map((z) => z.id),
    ...p.nodes.filter((n) => n.zone === null).map((n) => n.id),
  ]);

  const seen = new Set<string>();

  for (const f of OVERVIEW_FLOWS) {
    for (const end of [f.from, f.to]) {
      if (!boxes.has(end)) {
        errors.push(`vue d'ensemble : ${f.from} → ${f.to} vise une boîte inconnue ${end}`);
      }
    }

    if (seen.has(`${f.from}>${f.to}`)) {
      errors.push(`vue d'ensemble : ${f.from} → ${f.to} en double`);
    }

    seen.add(`${f.from}>${f.to}`);

    const backed = p.edges.some((e) => rootBoxOf(p, e.from) === f.from && rootBoxOf(p, e.to) === f.to);

    if (!backed) {
      errors.push(`vue d'ensemble : aucune flèche de brique ne joint ${f.from} → ${f.to}`);
    }
  }
}

function checkPlan(p: Plan, errors: string[]): void {
  const { nodes, zones } = checkIds(p, errors);
  checkZones(p, zones, errors);
  checkBricks(p, nodes, zones, errors);
  checkEdges(p, nodes, zones, errors);
  checkFlows(p, errors);
}

function checkMachine(m: Machine, errors: string[]): void {
  const states = new Set<string>();

  for (const s of m.states) {
    if (states.has(s.id)) {
      errors.push(`machine ${m.id} : état en double ${s.id}`);
    }

    states.add(s.id);
  }

  if (!states.has(m.initial)) {
    errors.push(`machine ${m.id} : état initial inconnu ${m.initial}`);
  }

  const ids = new Set<string>();
  const reached = new Set([m.initial]);

  for (const t of m.transitions) {
    if (ids.has(t.id)) {
      errors.push(`machine ${m.id} : transition en double ${t.id}`);
    }

    ids.add(t.id);

    for (const end of [t.from, t.to]) {
      if (!states.has(end)) {
        errors.push(`machine ${m.id} : transition ${t.id} vers un état inconnu ${end}`);
      }
    }

    if (t.from === t.to) {
      errors.push(`machine ${m.id} : transition ${t.id} boucle sur ${t.from}`);
    }
  }

  let grew = true;

  while (grew) {
    grew = false;

    for (const t of m.transitions) {
      if (reached.has(t.from) && !reached.has(t.to)) {
        reached.add(t.to);
        grew = true;
      }
    }
  }

  for (const s of m.states) {
    if (!reached.has(s.id)) {
      errors.push(`machine ${m.id} : état ${s.id} inaccessible depuis ${m.initial}`);
    }
  }
}

function checkFlow(f: Flow, errors: string[]): void {
  const nodes = new Set(f.nodes.map((n) => n.id));
  const edges = new Set(f.edges.map((e) => e.id));

  for (const e of f.edges) {
    for (const end of [e.from, e.to]) {
      if (!nodes.has(end)) {
        errors.push(`flux : flèche ${e.id} vers un nœud inconnu ${end}`);
      }
    }
  }

  for (const [i, s] of f.steps.entries()) {
    for (const id of s.nodes) {
      if (!nodes.has(id)) {
        errors.push(`flux : étape ${i + 1} allume un nœud inconnu ${id}`);
      }
    }

    for (const id of s.edges) {
      if (!edges.has(id)) {
        errors.push(`flux : étape ${i + 1} allume une flèche inconnue ${id}`);
      }
    }
  }
}

const VIEWS = new Set(["produit", "mecanique", "architecture"]);

// openToken reads one hash token: a view, then a zone or brick, then a machine, then a p- section.
function checkHashes(p: Plan, errors: string[]): void {
  const planIds = new Set([...p.zones.map((z) => z.id), ...p.nodes.map((n) => n.id)]);

  for (const id of planIds) {
    if (VIEWS.has(id) || id.startsWith("p-")) {
      errors.push(`id ${id} : masqué par une vue ou une section du produit dans le lien`);
    }
  }

  for (const m of MACHINES) {
    if (VIEWS.has(m.id) || planIds.has(m.id) || m.id.startsWith("p-")) {
      errors.push(`machine ${m.id} : son id est pris par une vue, une zone, une brique ou une section`);
    }
  }
}

export function validate(): string[] {
  const errors: string[] = [];
  checkPlan(PLAN, errors);
  checkHashes(PLAN, errors);

  const seen = new Set<string>();

  for (const m of MACHINES) {
    if (seen.has(m.id)) {
      errors.push(`machine en double : ${m.id}`);
    }

    seen.add(m.id);
    checkMachine(m, errors);
  }

  checkFlow(FLOW, errors);

  return errors;
}

if (import.meta.main) {
  const errors = validate();

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  console.log(
    `plan ok : ${PLAN.zones.length} zones, ${PLAN.nodes.length} briques, ${PLAN.edges.length} flèches, ${MACHINES.length} machines, ${FLOW.steps.length} étapes`,
  );
}
