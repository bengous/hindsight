import { foldText } from "../signals/markers.ts";
import { contentText, recordField, stringField, type JsonRecord } from "./json.ts";

export type UserEntryKind =
  | { readonly kind: "typed"; readonly text: string; readonly markerText: string }
  | { readonly kind: "interrupt" }
  | { readonly kind: "other" };

const OTHER: UserEntryKind = { kind: "other" };
const INTERRUPT_PREFIX = "[Request interrupted by user";
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

function slashCommand(text: string): UserEntryKind | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name === undefined) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  return args === "" ? OTHER : { kind: "typed", text: `${name} ${args}`, markerText: args };
}

export function classifyUserEntry(entry: JsonRecord): UserEntryKind {
  if (entry["toolUseResult"] !== undefined) return OTHER;
  if (entry["isMeta"] === true || entry["isCompactSummary"] === true || entry["isVisibleInTranscriptOnly"] === true) {
    return OTHER;
  }
  if (stringField(entry, "entrypoint") === "sdk-cli" || stringField(entry, "promptSource") === "sdk") return OTHER;
  const message = recordField(entry, "message");
  const raw = message === null ? "" : contentText(message["content"]);
  if (raw.trimStart().startsWith(INTERRUPT_PREFIX)) return { kind: "interrupt" };
  const origin = recordField(entry, "origin");
  if (origin === null || stringField(origin, "kind") !== "human") return OTHER;
  const text = cleanHumanText(raw);
  const command = slashCommand(text);
  if (command !== null) return command;
  return text === "" ? OTHER : { kind: "typed", text, markerText: text };
}
