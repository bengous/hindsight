import { foldText } from "./text.ts";

export type Marker =
  | "interrupt_followup"
  | "user_rejected"
  | "question_rejected"
  | "plan_rejected"
  | "correction_strong"
  | "correction_medium"
  | "frustration"
  | "standing_instruction";

export type MarkerContext = {
  readonly isFirstPrompt: boolean;
  readonly afterInterrupt: boolean;
  /** Tools the human rejected since their previous message. */
  readonly rejectedTools: readonly string[];
};

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const PASTED_CONTENT = /<pasted_content(?: id="[^"]*")?>([\s\S]*?)<\/pasted_content(?: id="[^"]*")?>/g;

const FORM_ROUND_HEADER =
  /^[^\S\n]*(?:[^:\n]{1,60},[^\S\n]*)?(?:round|tour)[^\S\n]+\d+[^\S\n]*\n(?=[^\S\n]*[^:\n]{1,40}[^\S\n]:[^\S\n])/gim;

const MARKDOWN_LINE = /^\s*(#|[-*>|+]\s|\d+[.)]\s|```|\{|<)/m;

const FIRST_PERSON_FR = /\b(je|j'|moi|mon|ma|mes)\b/;

const DICTATION_PROBE = 600;

const DICTATION_MIN_LENGTH = 150;

const PATH_OR_URL = /(?:^|[\s(])(?:~\/|\$HOME|[\w.-]+\/[\w.-]+\/)|:\/\//;

const TERMINAL_GLYPH = /[❯●⏺]/;

/**
 * The user's own dictation: long, first-person French, with no markdown, path, URL or terminal glyph.
 * Agent reports and copied terminal output fail at least one of these.
 */
export function isDictatedPaste(body: string): boolean {
  return (
    body.length >= DICTATION_MIN_LENGTH &&
    !MARKDOWN_LINE.test(body) &&
    !body.includes("**") &&
    !PATH_OR_URL.test(body) &&
    !TERMINAL_GLYPH.test(body) &&
    FIRST_PERSON_FR.test(foldText(body.slice(0, DICTATION_PROBE)))
  );
}

export function cleanHumanText(raw: string): string {
  return raw
    .replace(SYSTEM_REMINDER, "")
    .replace(PASTED_CONTENT, (_block, body: string) => (isDictatedPaste(body) ? body.trim() : ""))
    .replace(FORM_ROUND_HEADER, "")
    .trim();
}

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

const SLASH_COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;

const SLASH_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** A slash command's name and arguments when `text` is one; null for plain text. */
export function slashCommand(text: string): { readonly name: string; readonly args: string } | null {
  const name = SLASH_COMMAND_NAME.exec(text)?.[1]?.trim();

  if (name === undefined) {
    return null;
  }

  return { name, args: SLASH_COMMAND_ARGS.exec(text)?.[1]?.trim() ?? "" };
}
