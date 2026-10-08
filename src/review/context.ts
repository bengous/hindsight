import { redactSecrets } from "../model/redact.ts";

export type QuoteContext =
  | {
      readonly found: true;
      readonly before: string;
      readonly quote: string;
      readonly after: string;
      readonly clippedStart: boolean;
      readonly clippedEnd: boolean;
    }
  | { readonly found: false; readonly text: string; readonly clippedEnd: boolean };

const DEFAULT_WINDOW = 600;
const WORD_SNAP = 30;

function quotePattern(quote: string): RegExp | null {
  const words = quote
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  return new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
}

function snapStart(text: string, start: number): number {
  if (start === 0) return 0;
  const space = text.slice(start, start + WORD_SNAP).search(/\s/);
  return space === -1 ? start : start + space + 1;
}

function snapEnd(text: string, end: number): number {
  if (end === text.length) return end;
  const space = text.slice(Math.max(0, end - WORD_SNAP), end).search(/\s\S*$/);
  return space === -1 ? end : Math.max(0, end - WORD_SNAP) + space;
}

/** The redacted message around the quote, about `window` characters, cut at word boundaries. */
export function quoteContext(message: string, quote: string, window: number = DEFAULT_WINDOW): QuoteContext {
  const text = redactSecrets(message);
  const match = quotePattern(quote)?.exec(text) ?? null;
  if (match === null) {
    const end = text.length <= window ? text.length : snapEnd(text, window);
    return { found: false, text: text.slice(0, end), clippedEnd: end < text.length };
  }
  const at = match.index;
  const length = match[0].length;
  const room = Math.max(0, window - length);
  const availableBefore = at;
  const availableAfter = text.length - at - length;
  let before = Math.min(availableBefore, Math.floor(room / 2));
  const after = Math.min(availableAfter, room - before);
  before = Math.min(availableBefore, room - after);
  const start = snapStart(text, at - before);
  const end = snapEnd(text, at + length + after);
  return {
    found: true,
    before: text.slice(Math.min(start, at), at),
    quote: match[0],
    after: text.slice(at + length, Math.max(end, at + length)),
    clippedStart: start > 0,
    clippedEnd: end < text.length,
  };
}
