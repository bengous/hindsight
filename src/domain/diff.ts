export type TextEdit = { readonly oldText: string; readonly newText: string };

const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** One unified diff of the edits, as `Code format="diff"` draws it: a hunk per edit, old lines out, new lines in. */
export function unifiedDiff(path: string, edits: readonly TextEdit[]): string {
  const creation = edits.length === 1 && edits[0]?.oldText === "";
  const header = [`--- ${creation ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];

  const hunks = edits.map((edit) => {
    const removed = lines(edit.oldText);
    const added = lines(edit.newText);

    return [
      `@@ -1,${removed.length} +1,${added.length} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ].join("\n");
  });

  return [...header, ...hunks].join("\n");
}

export const NEWLINE_MARK = "⏎";

/** The pane's Input is one line: the mark stands for a line break both ways. */
export function toDraft(text: string): string {
  return text.replaceAll("\n", NEWLINE_MARK);
}

export function fromDraft(draft: string): string {
  return draft.replaceAll(NEWLINE_MARK, "\n");
}
