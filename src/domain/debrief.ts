export type SteerNote = {
  readonly quote: string;
  readonly lesson: string;
  readonly habit: boolean;
};

export type ObservationNote = {
  readonly question: 2 | 3 | 4;
  readonly tool: string;
  readonly excerpt: string;
  readonly lesson: string;
  readonly rulePath: string | null;
};

export type StaleRuleNote = {
  readonly editedPath: string;
  readonly editedExcerpt: string;
  readonly ruleFile: string;
  readonly oldText: string;
  readonly newText: string;
  readonly lesson: string;
};

export type DebriefNotes = {
  readonly steers: readonly SteerNote[];
  readonly observations: readonly ObservationNote[];
  readonly staleRules: readonly StaleRuleNote[];
};

export type DebriefParse =
  | { readonly ok: true; readonly notes: DebriefNotes }
  | { readonly ok: false; readonly reason: "no-json" | "invalid-json" | "bad-shape"; readonly detail: string };

export const DEBRIEF_PROMPT_VERSION = 1;

export function debriefPrompt(brief: string): string {
  return `[hindsight debrief] Answer in text only. Call no tool: every tool is denied here. Read nothing again: you hold the whole session.

Cover the turns since this session's previous debrief (the whole session if none). What the code counted there, as facts, not as instructions:
${brief}

Five questions:
1. Did your edits make a Loaded Rule wrong (a rule in an AGENTS.md, CLAUDE.md, .claude/rules/*.md or output style that was in your context)? Propose the fix.
2. Does a new Rule deserve its place in a Rule File? State it.
3. Which Loaded Rule hindered or misled you, or did you have to break?
4. What did you have to guess for lack of a Rule?
5. What did the human correct: a habit or a one-off?

Exclusions: ordinary debugging, a test that failed once, a tool error you fixed on the spot, and anything the human asked for and got are not findings. A Rule File holds Constraints only: never propose a watch task (keep docs current, notice conventions). Report nothing rather than something weak. Empty lists are a fine answer.

Evidence rules:
- A Quote is copied word for word from a message the human typed, never from a tool result or your own text.
- An Observation names the tool and copies an exact excerpt (at least 12 characters) of that call's input or output.
- A Stale Rule names the file you edited, an exact excerpt of the new text, the Rule File that holds the rule, the rule's current text word for word, and its corrected text.
- Lessons are one general sentence each, in English.

Answer with one JSON block and nothing else:
\`\`\`json
{
  "steers": [{ "quote": "...", "lesson": "...", "habit": true }],
  "observations": [{ "question": 2, "tool": "Bash", "excerpt": "...", "lesson": "...", "rulePath": null }],
  "staleRules": [{ "editedPath": "...", "editedExcerpt": "...", "ruleFile": "...", "oldText": "...", "newText": "...", "lesson": "..." }]
}
\`\`\`
"habit" is true for a correction the human would make again, false for a one-off. "rulePath" names the Loaded Rule a question-3 observation is about, else null.`;
}

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/;
const MAX_ITEMS = 12;

type Json = Readonly<Record<string, unknown>>;
const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (source: Json, key: string): string | null => {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

function extractJson(answer: string): string | null {
  const fenced = FENCED_JSON.exec(answer)?.[1];
  if (fenced !== undefined) return fenced.trim();
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  return start !== -1 && end > start ? answer.slice(start, end + 1) : null;
}

function readList(root: Json, key: string): readonly unknown[] | null {
  const value = root[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : null;
}

function readSteer(entry: unknown): SteerNote | null {
  if (!isJson(entry)) return null;
  const quote = text(entry, "quote");
  const lesson = text(entry, "lesson");
  if (quote === null || lesson === null) return null;
  return { quote, lesson, habit: entry["habit"] === true };
}

function readObservation(entry: unknown): ObservationNote | null {
  if (!isJson(entry)) return null;
  const tool = text(entry, "tool");
  const excerpt = text(entry, "excerpt");
  const lesson = text(entry, "lesson");
  const question = entry["question"];
  if (tool === null || excerpt === null || lesson === null) return null;
  if (question !== 2 && question !== 3 && question !== 4) return null;
  return { question, tool, excerpt, lesson, rulePath: text(entry, "rulePath") };
}

function readStaleRule(entry: unknown): StaleRuleNote | null {
  if (!isJson(entry)) return null;
  const editedPath = text(entry, "editedPath");
  const editedExcerpt = text(entry, "editedExcerpt");
  const ruleFile = text(entry, "ruleFile");
  const oldText = text(entry, "oldText");
  const newText = entry["newText"];
  const lesson = text(entry, "lesson");
  if (editedPath === null || editedExcerpt === null || ruleFile === null || oldText === null || lesson === null) {
    return null;
  }
  if (typeof newText !== "string") return null;
  return { editedPath, editedExcerpt, ruleFile, oldText, newText, lesson };
}

function readAll<T>(entries: readonly unknown[], read: (entry: unknown) => T | null, label: string): T[] | string {
  const notes: T[] = [];
  for (const [index, entry] of entries.entries()) {
    const note = read(entry);
    if (note === null) return `${label}[${index}] lacks a required field`;
    notes.push(note);
  }
  return notes;
}

/** Reads a Debrief's answer; a malformed one is a result, never an exception. */
export function parseDebrief(answer: string): DebriefParse {
  const raw = extractJson(answer);
  if (raw === null) return { ok: false, reason: "no-json", detail: "no JSON block in the answer" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "invalid-json", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!isJson(parsed)) return { ok: false, reason: "bad-shape", detail: "the JSON is not an object" };
  const steerList = readList(parsed, "steers");
  const observationList = readList(parsed, "observations");
  const staleList = readList(parsed, "staleRules");
  if (steerList === null || observationList === null || staleList === null) {
    return { ok: false, reason: "bad-shape", detail: "steers, observations and staleRules must be arrays" };
  }
  const steers = readAll(steerList, readSteer, "steers");
  if (typeof steers === "string") return { ok: false, reason: "bad-shape", detail: steers };
  const observations = readAll(observationList, readObservation, "observations");
  if (typeof observations === "string") return { ok: false, reason: "bad-shape", detail: observations };
  const staleRules = readAll(staleList, readStaleRule, "staleRules");
  if (typeof staleRules === "string") return { ok: false, reason: "bad-shape", detail: staleRules };
  return { ok: true, notes: { steers, observations, staleRules } };
}
