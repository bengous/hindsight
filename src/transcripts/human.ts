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
const MARKDOWN_LINE = /^\s*(#|[-*>|+]\s|\d+[.)]\s|```|\{|<)/m;
const FIRST_PERSON_FR = /\b(je|j'|moi|mon|ma|mes)\b/;
const DICTATION_PROBE = 600;
const REJECTION_LEAD = /the user said:\s*/;
const REJECTION_NOTE = /\n+Note: The user's next message may contain a correction or preference[\s\S]*$/;
const CLARIFY_BOILERPLATE = "The user wants to clarify these questions";

/** A paste with no markdown and a French first-person marker is the user's own dictation; anything else is foreign. */
export function isDictatedPaste(body: string): boolean {
  return (
    !MARKDOWN_LINE.test(body) && !body.includes("**") && FIRST_PERSON_FR.test(foldText(body.slice(0, DICTATION_PROBE)))
  );
}

export function cleanHumanText(raw: string): string {
  return raw
    .replace(SYSTEM_REMINDER, "")
    .replace(PASTED_CONTENT, (_block, body: string) => (isDictatedPaste(body) ? body.trim() : ""))
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

/** Feedback the human typed when rejecting a tool call, or null when the rejection carries none. */
export function rejectionFeedback(resultText: string): string | null {
  const lead = REJECTION_LEAD.exec(resultText);
  if (lead === null) return null;
  const feedback = cleanHumanText(resultText.slice(lead.index + lead[0].length).replace(REJECTION_NOTE, ""));
  if (feedback === "" || feedback.startsWith(CLARIFY_BOILERPLATE)) return null;
  return feedback;
}
