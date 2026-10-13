import type { RuleBullet } from "./types.ts";

import { Predicate, Schema } from "effect";

import { splitTopLevel } from "./glob.ts";

export type BodyLine = {
  /** 1-based line number in the file. */
  readonly line: number;
  readonly text: string;
  readonly fenced: boolean;
};

export type CodeSpan = {
  readonly line: number;
  readonly code: string;
};

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/;

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

const FENCE = /^\s*(```|~~~)/;

const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

const hasPathsField = Schema.is(Schema.Struct({ paths: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]) }));

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") {
    return 0;
  }

  const close = lines.findIndex((text, index) => index > 0 && text.trim() === "---");

  return close === -1 ? 0 : close + 1;
}

export function frontmatterText(text: string): string | null {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);

  return end === 0 ? null : lines.slice(1, end - 1).join("\n");
}

/** `paths:` globs as Claude Code reads them: a YAML list or a comma-separated string; unparsable YAML means none. */
export function frontmatterPaths(text: string): readonly string[] | null {
  const frontmatter = frontmatterText(text);

  if (frontmatter === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = Bun.YAML.parse(frontmatter);
  } catch {
    return null;
  }

  if (!hasPathsField(parsed)) {
    return null;
  }

  const { paths } = parsed;
  const globs = Predicate.isString(paths) ? splitTopLevel(paths) : paths.filter(Predicate.isString);

  const cleaned = globs.map((glob) => glob.trim()).filter((glob) => glob !== "");

  return cleaned.length === 0 ? null : cleaned;
}

export function bodyLines(text: string): readonly BodyLine[] {
  const lines = text.split("\n");
  const start = frontmatterEnd(lines);
  const body: BodyLine[] = [];
  let open: string | null = null;

  for (const [index, content] of lines.entries()) {
    if (index < start) {
      continue;
    }

    const marker = FENCE.exec(content)?.[1] ?? null;

    if (marker !== null && (open === null || open === marker)) {
      body.push({ line: index + 1, text: content, fenced: true });
      open = open === null ? marker : null;

      continue;
    }

    body.push({ line: index + 1, text: content, fenced: open !== null });
  }

  return body;
}

export function codeSpans(text: string): readonly CodeSpan[] {
  return bodyLines(text)
    .filter((line) => !line.fenced)
    .flatMap((line) =>
      [...line.text.matchAll(INLINE_CODE)].map((match) => ({ line: line.line, code: (match[2] ?? "").trim() })),
    );
}

export function normalizeBullet(text: string): string {
  return text.replace(LIST_MARKER, "").replaceAll(/\s+/g, " ").trim();
}

function shortSha1(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex").slice(0, 8);
}

/** List items with their continuation lines, verbatim; ids hash the normalized text so they survive line moves. */
export function ruleBullets(text: string, idPrefix: string): readonly RuleBullet[] {
  const bullets: Array<{ line: number; lines: string[]; indent: number }> = [];
  let current: { line: number; lines: string[]; indent: number } | null = null;

  for (const line of bodyLines(text)) {
    const item = line.fenced ? null : LIST_ITEM.exec(line.text);

    if (item !== null) {
      current = { line: line.line, lines: [line.text], indent: item[1]?.length ?? 0 };
      bullets.push(current);
      continue;
    }

    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;

    if (current !== null && !line.fenced && line.text.trim() !== "" && indent > current.indent) {
      current.lines.push(line.text);
      continue;
    }

    current = null;
  }

  const seen = new Map<string, number>();

  return bullets.map((bullet) => {
    const verbatim = bullet.lines.join("\n");
    const hash = shortSha1(normalizeBullet(verbatim));
    const count = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, count);

    return { id: `${idPrefix}#${hash}${count === 1 ? "" : `~${count}`}`, line: bullet.line, text: verbatim };
  });
}

export function bulletAt(bullets: readonly RuleBullet[], line: number): RuleBullet | null {
  return bullets.find((bullet) => line >= bullet.line && line < bullet.line + bullet.text.split("\n").length) ?? null;
}

/** `@path` imports outside code, with `\ ` unescaped. Existence is checked by the caller. */
export function importTargets(text: string): readonly string[] {
  return bodyLines(text)
    .filter((line) => !line.fenced)
    .flatMap((line) => {
      const prose = line.text.replace(INLINE_CODE, " ");

      return [...prose.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)].map((match) =>
        (match[1] ?? "").replaceAll(String.raw`\ `, " ").replace(/[.,;:!?)]+$/, ""),
      );
    })
    .filter((target) => target !== "");
}
