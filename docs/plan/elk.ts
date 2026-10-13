export type LayoutOptions = Readonly<Record<string, string>>;

export type ElkPoint = { readonly x: number; readonly y: number };

export type ElkShape = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: LayoutOptions;
};

export type ElkLabel = Omit<ElkShape, "id"> & { text: string };

export type ElkEdgeSection = {
  readonly id: string;
  readonly startPoint: ElkPoint;
  readonly endPoint: ElkPoint;
  readonly bendPoints?: ElkPoint[];
};

export type ElkExtendedEdge = {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabel[];
  sections?: ElkEdgeSection[];
  layoutOptions?: LayoutOptions;
};

export type ElkNode = ElkShape & {
  children?: ElkNode[];
  ports?: ElkShape[];
  edges?: ElkExtendedEdge[];
  labels?: ElkLabel[];
};

export type Elk = { readonly layout: (graph: ElkNode) => Promise<ElkNode> };

type ElkCtor = new () => Elk;

const isElkCtor = (value: unknown): value is ElkCtor => typeof value === "function";

export function elk(): Elk {
  const Ctor: unknown = Reflect.get(globalThis, "ELK");

  if (!isElkCtor(Ctor)) {
    throw new Error("elkjs ne s'est pas chargé (cdn.jsdelivr.net bloqué ?)");
  }

  return new Ctor();
}
