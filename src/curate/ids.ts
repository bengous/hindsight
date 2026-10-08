import type { IsoTimestamp } from "../types.ts";
import { homedir } from "node:os";

export function sha1(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

export function normalizeLesson(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when `quote` appears in `text`, ignoring only differences in whitespace runs. */
export function containsVerbatim(text: string, quote: string): boolean {
  const needle = collapseWhitespace(quote);
  return needle.length > 0 && collapseWhitespace(text).includes(needle);
}

export function utcDay(timestamp: IsoTimestamp): string {
  return timestamp.slice(0, 10);
}

export function expandHome(path: string, home: string = homedir()): string {
  return path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** Repository-relative or `~`-relative form for prompts and cards. */
export function displayPath(path: string, repoRoot: string | null, home: string = homedir()): string {
  if (repoRoot !== null && path.startsWith(`${repoRoot}/`)) {
    return path.slice(repoRoot.length + 1);
  }
  if (path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path;
}

export function isSeedId(id: string): boolean {
  return id.startsWith("mem:");
}
