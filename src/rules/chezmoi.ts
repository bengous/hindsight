import { join } from "node:path";
import { run } from "./git.ts";

/** Maps a deployed file to the file to edit: its chezmoi source, or itself when chezmoi does not manage it. */
export type SourceResolver = (loadedPath: string) => Promise<string>;

export type ChezmoiOptions = {
  readonly home: string;
  readonly timeoutMs: number;
};

const includeOnly = /^\{\{-?\s*include\s+"([^"]+)"\s*-?\}\}$/;

/** The included path when a template is nothing but one `include`, else null. */
export function unwrapInclude(template: string): string | null {
  return includeOnly.exec(template.trim())?.[1] ?? null;
}

export function identityResolver(): SourceResolver {
  return async (loadedPath) => loadedPath;
}

export function chezmoiResolver(options: ChezmoiOptions): SourceResolver {
  let sourceDir: Promise<string> | null = null;

  const chezmoi = async (args: readonly string[]): Promise<{ exitCode: number; stdout: string }> => {
    const result = await run(["chezmoi", ...args], { cwd: options.home, timeoutMs: options.timeoutMs });
    if (result.exitCode > 128) {
      throw new Error(`chezmoi ${args.join(" ")} timed out or was killed (exit ${result.exitCode})`);
    }
    return result;
  };

  return async (loadedPath) => {
    const found = await chezmoi(["source-path", loadedPath]);
    if (found.exitCode !== 0) return loadedPath;
    const source = found.stdout.trim();
    if (!source.endsWith(".tmpl")) return source;
    const included = unwrapInclude(await Bun.file(source).text());
    if (included === null) return source;
    sourceDir ??= chezmoi(["source-path"]).then((result) => {
      if (result.exitCode !== 0) throw new Error(`chezmoi source-path failed (exit ${result.exitCode})`);
      return result.stdout.trim();
    });
    return join(await sourceDir, included);
  };
}

export function defaultResolver(home: string): SourceResolver {
  return Bun.which("chezmoi") === null ? identityResolver() : chezmoiResolver({ home, timeoutMs: 10_000 });
}
