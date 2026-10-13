export type Color =
  | "--z-session"
  | "--z-mod"
  | "--z-domain"
  | "--z-cli"
  | "--z-store"
  | "--z-model"
  | "--z-rules"
  | "--z-ext"
  | "--z-human";

export type Pair = readonly [string, string];

// The right panel's content, in the order the panel shows it. HTML is allowed.
export type Info = {
  readonly kicker?: string;
  readonly title: string;
  readonly lead?: string;
  readonly io?: readonly Pair[];
  readonly swap?: string;
  readonly extend?: string;
  readonly why?: readonly string[];
  readonly alt?: string;
  readonly facts?: readonly Pair[];
  readonly warn?: string;
  readonly how?: string;
  readonly see?: readonly string[];
  readonly src?: string;
};

export type Zone = {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly color: Color;
  readonly kw: readonly string[];
  readonly info: Info;
  readonly parent?: string;
};

export type Side = "in" | "out";

export type Brick = {
  readonly id: string;
  readonly zone: string | null;
  readonly label: string;
  readonly sub: string;
  readonly info: Info;
  readonly color: Color;
  readonly couples: readonly string[];
  readonly side?: Side;
};

export type Edge = {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind?: "deny" | "dash";
  readonly two?: true;
};

export type Plan = {
  readonly overview: Info;
  readonly zones: readonly Zone[];
  readonly nodes: readonly Brick[];
  readonly edges: readonly Edge[];
  readonly zoneOrder: readonly string[];
};

export type Actor = "human" | "model" | "code" | "time";

export type MState = {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
  readonly lead: string;
  readonly kind?: "initial" | "final" | "check" | "outcome";
  readonly where?: string;
};

export type MTransition = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly by: Actor;
  readonly guard?: string;
  readonly desc: string;
  readonly src?: string;
};

export type Machine = {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly lead: string;
  readonly store: string;
  readonly initial: string;
  readonly states: readonly MState[];
  readonly transitions: readonly MTransition[];
  readonly direction: "RIGHT" | "DOWN";
  readonly facts?: readonly Pair[];
  readonly src?: string;
};

export type FlowNode = {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly by: Actor;
  readonly info: string;
};

export type FlowEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind?: "dash";
};

export type Step = {
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
  readonly text: string;
};

export type Flow = {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly steps: readonly Step[];
};

export type AddBrick = (
  zone: string | null,
  id: string,
  label: string,
  sub: string,
  info: Info,
  options: Pick<Brick, "color" | "couples" | "side">,
) => void;

export function brickAdder(bricks: Brick[]): AddBrick {
  return (zone, id, label, sub, info, options) => {
    bricks.push({ zone, id, label, sub, info, ...options });
  };
}

export type AddEdge = (from: string, to: string, label: string, options?: Pick<Edge, "kind" | "two">) => void;

export function edgeAdder(edges: Edge[]): AddEdge {
  return (from, to, label, options) => {
    edges.push({ from, to, label, ...options });
  };
}
