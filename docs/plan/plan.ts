import type { Brick, Edge, Plan, Zone } from "./model.ts";

import { bricksCli } from "./data-bricks-cli.ts";
import { bricksMod } from "./data-bricks-mod.ts";
import { bricks } from "./data-bricks.ts";
import { edges } from "./data-edges.ts";
import { OVERVIEW, ZONES, ZONE_ORDER } from "./data-zones.ts";

export const PLAN: Plan = {
  overview: OVERVIEW,
  zones: ZONES,
  nodes: [...bricks, ...bricksMod, ...bricksCli],
  edges,
  zoneOrder: ZONE_ORDER,
};

const ZONES_BY_ID = new Map(PLAN.zones.map((z) => [z.id, z]));

const NODES_BY_ID = new Map(PLAN.nodes.map((n) => [n.id, n]));

export function zone(id: string): Zone {
  const z = ZONES_BY_ID.get(id);

  if (z === undefined) {
    throw new Error(`plan : zone inconnue ${id}`);
  }

  return z;
}

export function node(id: string): Brick {
  const n = NODES_BY_ID.get(id);

  if (n === undefined) {
    throw new Error(`plan : brique inconnue ${id}`);
  }

  return n;
}

export const isZone = (id: string): boolean => ZONES_BY_ID.has(id);

export const isNode = (id: string): boolean => NODES_BY_ID.has(id);

export const zoneOfNode = (id: string): string | null => node(id).zone;

export const kidsOf = (zid: string): string[] => PLAN.zones.filter((z) => z.parent === zid).map((z) => z.id);

export const nestsZone = (zid: string): boolean => PLAN.zones.some((z) => z.parent === zid);

// A zone that holds sub-zones keeps its own bricks in a borderless group laid out like a sub-zone.
export const OWN = "~own";

export const zoneBox = (zid: string): string => (nestsZone(zid) ? zid + OWN : zid);

export const groupOf = (n: Brick): string | null => (n.zone === null ? null : zoneBox(n.zone));

export const links: readonly Edge[] = PLAN.edges;

export const outside: readonly Brick[] = PLAN.nodes.filter((n) => n.zone === null);

export const nestOrder = (zid: string): string[] => [zid, ...kidsOf(zid).flatMap(nestOrder)];

export const roots: readonly Zone[] = PLAN.zones.filter((z) => z.parent === undefined);

export function parentMap(): Map<string, string> {
  const parents = new Map<string, string>();

  for (const z of PLAN.zones) {
    if (z.parent !== undefined) {
      parents.set(z.id, z.parent);
    }

    if (nestsZone(z.id)) {
      parents.set(z.id + OWN, z.id);
    }
  }

  return parents;
}

export function coupledWith(id: string): string[] {
  const set = new Set(node(id).couples);

  for (const n of PLAN.nodes) {
    if (n.couples.includes(id)) {
      set.add(n.id);
    }
  }

  set.delete(id);

  return [...set].filter(isNode);
}
