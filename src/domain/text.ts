export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .replaceAll(/[‘’]/g, "'")
    .toLowerCase();
}

export function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/** True when `quote` appears in `text`, ignoring only differences in whitespace runs. */
export function containsVerbatim(text: string, quote: string): boolean {
  const needle = collapseWhitespace(quote);

  return needle.length > 0 && collapseWhitespace(text).includes(needle);
}

export function normalizeLesson(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function utcDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

const KEPT_CONTROLS = new Set(["\n", "\t"]);

/** Text safe for a terminal element: no control character but newline and tab, cut to `max` characters. */
export function displayText(text: string, max: number): string {
  const clean = text.replaceAll(/\p{Cc}/gu, (char) => (KEPT_CONTROLS.has(char) ? char : ""));

  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
