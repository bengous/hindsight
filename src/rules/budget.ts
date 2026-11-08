import type { RuleFile } from "./types.ts";

export type Oversized = { readonly file: RuleFile; readonly chars: number };

/** An edit grows a Rule File up to the Size Budget, and never lengthens one already past it. */
export function fitsBudget(before: string, after: string, budget: number): boolean {
  return after.length <= Math.max(budget, before.length);
}

/** The Rule Files over the Size Budget, global ones included. */
export async function oversized(files: readonly RuleFile[], budget: number): Promise<readonly Oversized[]> {
  const measured = await Promise.all(
    files.map(async (file) => ({ file, chars: (await Bun.file(file.sourcePath).text()).length })),
  );

  return measured.filter((entry) => entry.chars > budget);
}
