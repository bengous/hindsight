import type { Marker } from "../types.ts";

export type MarkerContext = {
  readonly isFirstPrompt: boolean;
  readonly afterInterrupt: boolean;
  /** Tools the human rejected since their previous message. */
  readonly rejectedTools: readonly string[];
};

const CORRECTION_STRONG = [
  /\bje (te l'|t'en |t'|vous )?(ai|avais) (deja |pourtant |bien )?(dit|demande|precise|explique)/,
  /\bon (en )?avait (dit|convenu|decide)/,
  /\bcombien de fois\b/,
  /\bencore une fois\b/,
  /\btoujours pas\b/,
  /\bc'est faux\b/,
  /\bn'importe quoi\b/,
  /\bpas (du tout )?ce que (je|j'ai)\b/,
  /\b(tu as|t'as|tu t'es|t'es) (encore |deja )?(oublie|trompe|invente|ignore|zappe)/,
  /\btu n'as pas (lu|respecte|suivi|verifie|teste)/,
  /\bpourquoi (tu as|as-tu|t'as|est-ce que tu|tu n'as|tu ne)\b/,
  /\b(il ne|ne) fallait pas\b/,
  /\bj'ai jamais (dit|demande)\b|\bje n'ai jamais (dit|demande)\b/,
  /\barrete de\b/,
  /\bi (already )?(told|asked) you\b/,
  /\bnot what i (asked|wanted|said|meant)\b/,
  /\bwhy did you\b/,
];

const CORRECTION_MEDIUM = [
  /^\s*non\b/,
  /^\s*no[,.!]/,
  /\bpas comme (ca|cela)\b/,
  /\bau lieu de\b/,
  /\bne (fais|touche|modifie|supprime|lance|commit|push|mets|utilise|ajoute|cree)\w* (pas|jamais|rien)\b/,
  /\b(remets|annule|revert|undo)\b/,
  /\btu (n')?aurais (du|pu)\b/,
  /\bstop\b/,
  /\bwrong\b/,
  /\bdon'?t (do|touch|change|commit|push|use|add)\b/,
];

const FRUSTRATION = [
  /\b(putain|bordel|merde|chier|chiant|relou|wtf|me saoule|debecte|j'en ai marre)\b/,
  /\bpas besoin d(e\b|')/,
  /\bfranchement\b/,
];

const STANDING_INSTRUCTION = [
  /\bje (te )?rappelle\b|\brappelle-toi\b/,
  /\bcomme (d'habitude|indique|ecrit|dit dans|prevu)\b/,
  /\b(agents|claude)\.md\b/,
  /\bles? regles?\b|\.claude\/rules\b|\bconventions?\b/,
  /\bmemoires?\b|\bmemory\b|\bretiens\b|\bnote (ca|bien)\b/,
  /\b(a chaque fois|a l'avenir|dorenavant|desormais|la prochaine fois|from now on|next time|every time)\b/,
];

const MEDIUM_SCOPE = 400;

const MARKER_ORDER: readonly Marker[] = [
  "interrupt_followup",
  "user_rejected",
  "question_rejected",
  "plan_rejected",
  "correction_strong",
  "correction_medium",
  "frustration",
  "standing_instruction",
];

export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

const matchesAny = (patterns: readonly RegExp[], text: string): boolean => patterns.some((p) => p.test(text));

export function markersFor(text: string, context: MarkerContext): readonly Marker[] {
  const folded = foldText(text);
  const strong = matchesAny(CORRECTION_STRONG, folded);
  const flags: Record<Marker, boolean> = {
    interrupt_followup: context.afterInterrupt,
    user_rejected: context.rejectedTools.length > 0,
    question_rejected: context.rejectedTools.includes("AskUserQuestion"),
    plan_rejected: context.rejectedTools.includes("ExitPlanMode"),
    correction_strong: strong,
    correction_medium:
      !strong && !context.isFirstPrompt && matchesAny(CORRECTION_MEDIUM, folded.slice(0, MEDIUM_SCOPE)),
    frustration: matchesAny(FRUSTRATION, folded),
    standing_instruction: matchesAny(STANDING_INSTRUCTION, folded),
  };
  return MARKER_ORDER.filter((marker) => flags[marker]);
}
