import type { Point, Rect } from "./camera.ts";
import type { ElkExtendedEdge, ElkLabel, ElkNode, LayoutOptions } from "./elk.ts";

import { elk } from "./elk.ts";

// ELK lays out each zone on its own (SEPARATE_CHILDREN), which keeps a zone
// compact, but then routes no arrow across a zone border. Such an arrow is cut
// into one segment per level, joined by ports on the borders, and glued back
// into one polyline after the layout. elk.layered.compaction.postCompaction
// must stay off: with ports on compound nodes it throws on hitboxes.
export const LAYERED: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.spacing.nodeNodeBetweenLayers": "52",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeLabel": "3",
  "elk.edgeLabels.placement": "CENTER",
};

const ROOT_COORDS: LayoutOptions = {
  "org.eclipse.elk.json.shapeCoords": "ROOT",
  "org.eclipse.elk.json.edgeCoords": "ROOT",
};

export type Group = { readonly pad: string; readonly minW?: number; readonly options?: LayoutOptions };

export type Leaf = { readonly id: string; readonly w: number; readonly h: number; readonly group: string | null };

export type LayoutEdge = { readonly from: string; readonly to: string; readonly label: string; readonly flip: boolean };

export type LabelSize = { readonly width: number; readonly height: number };

export type LaidPath = { readonly pts: Point[]; readonly label: Rect | null };

export type Laid = {
  readonly w: number;
  readonly h: number;
  readonly boxes: ReadonlyMap<string, Rect>;
  readonly paths: readonly LaidPath[];
};

type Compound = { readonly node: ElkNode; readonly children: ElkNode[]; readonly edges: ElkExtendedEdge[] };

type Cut = { readonly ids: readonly string[]; readonly mid: string; readonly flip: boolean };

export function rectOf(n: ElkNode | ElkLabel): Rect {
  if (n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined) {
    throw new Error(`ELK a rendu ${"id" in n ? n.id : "une étiquette"} sans position ou sans taille`);
  }

  return { x: n.x, y: n.y, w: n.width, h: n.height };
}

function compound(id: string, layoutOptions: LayoutOptions): Compound {
  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];

  return { node: { id, layoutOptions, children, edges, ports: [] }, children, edges };
}

function groupOptions(g: Group, base: LayoutOptions): LayoutOptions {
  const sized: LayoutOptions =
    g.minW === undefined
      ? {}
      : { "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": `(${Math.ceil(g.minW)}, 90)` };

  return { ...base, "elk.padding": g.pad, ...sized, ...g.options };
}

class Graph {
  readonly root: Compound;
  private readonly groups = new Map<string, Compound>();
  private readonly groupOfLeaf = new Map<string, string | null>();

  constructor(
    groups: ReadonlyMap<string, Group>,
    private readonly parentOf: ReadonlyMap<string, string>,
    leaves: readonly Leaf[],
    base: LayoutOptions,
  ) {
    this.root = compound("root", { ...base, ...ROOT_COORDS });

    for (const [id, g] of groups) {
      this.groups.set(id, compound(id, groupOptions(g, base)));
    }

    for (const [id, c] of this.groups) {
      this.container(this.parentOf.get(id) ?? null).children.push(c.node);
    }

    for (const l of leaves) {
      this.groupOfLeaf.set(l.id, l.group);
      this.container(l.group).children.push({ id: l.id, width: l.w, height: l.h });
    }
  }

  container(group: string | null): Compound {
    if (group === null) {
      return this.root;
    }

    const c = this.groups.get(group);

    if (c === undefined) {
      throw new Error(`ELK : groupe inconnu ${group}`);
    }

    return c;
  }

  pathOf(id: string): string[] {
    const path: string[] = [];

    for (let g = this.groupOfLeaf.get(id) ?? null; g !== null; g = this.parentOf.get(g) ?? null) {
      path.unshift(g);
    }

    return path;
  }

  addPort(group: string, port: string): void {
    this.container(group).node.ports?.push({ id: port, width: 1, height: 1 });
  }

  cut(e: LayoutEdge, i: number, labelSize: (t: string) => LabelSize): Cut {
    const [from, to] = e.flip ? [e.to, e.from] : [e.from, e.to];
    const pu = this.pathOf(from);
    const pv = this.pathOf(to);
    let k = 0;

    while (k < pu.length && k < pv.length && pu[k] === pv[k]) {
      k += 1;
    }

    const up: string[] = [];
    const down: string[] = [];
    let src = from;
    let dst = to;

    for (let d = pu.length - 1; d >= k; d -= 1) {
      const group = pu[d] ?? "";
      this.addPort(group, `p${i}u${d}`);
      this.container(group).edges.push({ id: `e${i}u${d}`, sources: [src], targets: [`p${i}u${d}`] });
      up.push(`e${i}u${d}`);
      src = `p${i}u${d}`;
    }

    for (let d = pv.length - 1; d >= k; d -= 1) {
      const group = pv[d] ?? "";
      this.addPort(group, `p${i}d${d}`);
      this.container(group).edges.push({ id: `e${i}d${d}`, sources: [`p${i}d${d}`], targets: [dst] });
      down.unshift(`e${i}d${d}`);
      dst = `p${i}d${d}`;
    }

    const labels = e.label === "" ? [] : [{ text: e.label, ...labelSize(e.label) }];
    const middle = k > 0 ? this.container(pu[k - 1] ?? null) : this.root;
    middle.edges.push({ id: `e${i}m`, sources: [src], targets: [dst], labels });

    return { ids: [...up, `e${i}m`, ...down], mid: `e${i}m`, flip: e.flip };
  }
}

function collect(n: ElkNode, edges: Map<string, ElkExtendedEdge>, boxes: Map<string, Rect>): void {
  for (const e of n.edges ?? []) {
    edges.set(e.id, e);
  }

  for (const c of n.children ?? []) {
    boxes.set(c.id, rectOf(c));
    collect(c, edges, boxes);
  }
}

function laidEdge(edges: ReadonlyMap<string, ElkExtendedEdge>, id: string): ElkExtendedEdge {
  const e = edges.get(id);

  if (e === undefined) {
    throw new Error(`ELK n'a rendu aucune flèche ${id}`);
  }

  return e;
}

function glue(cut: Cut, edges: ReadonlyMap<string, ElkExtendedEdge>): LaidPath {
  const pts: Point[] = [];

  for (const id of cut.ids) {
    const s = laidEdge(edges, id).sections?.[0];

    if (s === undefined) {
      throw new Error(`ELK n'a rendu aucun tracé pour ${id}`);
    }

    for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
      const q = pts.at(-1);

      if (q === undefined || Math.hypot(p.x - q[0], p.y - q[1]) > 1.5) {
        pts.push([p.x, p.y]);
      }
    }
  }

  if (cut.flip) {
    pts.reverse();
  }

  const label = laidEdge(edges, cut.mid).labels?.[0];

  return { pts, label: label === undefined ? null : rectOf(label) };
}

export async function elkNested(
  groups: ReadonlyMap<string, Group>,
  parentOf: ReadonlyMap<string, string>,
  leaves: readonly Leaf[],
  edges: readonly LayoutEdge[],
  labelSize: (t: string) => LabelSize,
  options: LayoutOptions = {},
): Promise<Laid> {
  const graph = new Graph(groups, parentOf, leaves, { ...LAYERED, ...options });
  const cuts = edges.map((e, i) => graph.cut(e, i, labelSize));
  const res = await elk().layout(graph.root.node);
  const laidEdges = new Map<string, ElkExtendedEdge>();
  const boxes = new Map<string, Rect>();
  collect(res, laidEdges, boxes);

  return {
    w: res.width ?? 0,
    h: res.height ?? 0,
    boxes,
    paths: cuts.map((c) => glue(c, laidEdges)),
  };
}
