import type { EvidenceId, IsoTimestamp, SessionDigest } from "../types.ts";
import { basename } from "node:path";
import { sha1 } from "./ids.ts";

export type SeedNote = {
  readonly path: string;
  readonly repoRoot: string;
  readonly text: string;
  readonly modifiedAt: IsoTimestamp;
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function splitFrontmatter(text: string): { readonly name: string | null; readonly body: string } {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return { name: null, body: text.trim() };
  }
  const name = /^name:\s*(.+)$/m.exec(match[1] ?? "")?.[1]?.trim() ?? null;
  return { name, body: text.slice(match[0].length).trim() };
}

/** An old auto-memory note becomes a one-message session whose evidence id is `mem:<path>`. */
export function seedDigest(note: SeedNote): SessionDigest {
  const { name, body } = splitFrontmatter(note.text);
  const evidenceId: EvidenceId = `mem:${note.path}`;
  return {
    sessionId: evidenceId,
    chain: [evidenceId],
    title: name ?? basename(note.path, ".md"),
    cwd: note.repoRoot,
    repoRoot: note.repoRoot,
    firstAt: note.modifiedAt,
    lastAt: note.modifiedAt,
    messages: [
      {
        evidenceId,
        sessionId: evidenceId,
        uuid: sha1(note.text),
        timestamp: note.modifiedAt,
        cwd: note.repoRoot,
        text: body,
        precedingAssistant: "",
        loadedRulePaths: [],
        markers: ["standing_instruction"],
      },
    ],
    loadedRules: [],
    filesTouched: [],
  };
}
