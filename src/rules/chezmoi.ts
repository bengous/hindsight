import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./git.ts";

/**
 * Maps a deployed file to the files to edit: its chezmoi source first, then the existing files a template pulls in
 * with `template` or `include`; or the file itself when chezmoi does not manage it.
 */
export type SourceResolver = (loadedPath: string) => Promise<readonly string[]>;

export type ChezmoiOptions = {
  readonly home: string;
  readonly timeoutMs: number;
};

const includeOnly = /^\{\{-?\s*include\s+"([^"]+)"\s*-?\}\}$/;
const templateReference = /\{\{-?\s*(include|template)\s+"([^"]+)"/g;

/** The included path when a template is nothing but one `include`, else null. */
export function unwrapInclude(template: string): string | null {
  return includeOnly.exec(template.trim())?.[1] ?? null;
}

/** Source-dir-relative paths of the files a template pulls in: `include` from the source dir, `template` from `.chezmoitemplates`. */
export function templateReferences(template: string): readonly string[] {
  return [...template.matchAll(templateReference)].map(([, directive, name]) =>
    directive === "template" ? join(".chezmoitemplates", name ?? "") : (name ?? ""),
  );
}

export function identityResolver(): SourceResolver {
  return async (loadedPath) => [loadedPath];
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

  const root = (): Promise<string> => {
    sourceDir ??= chezmoi(["source-path"]).then((result) => {
      if (result.exitCode !== 0) throw new Error(`chezmoi source-path failed (exit ${result.exitCode})`);
      return result.stdout.trim();
    });
    return sourceDir;
  };

  return async (loadedPath) => {
    const found = await chezmoi(["source-path", loadedPath]);
    if (found.exitCode !== 0) return [loadedPath];
    const source = found.stdout.trim();
    if (!source.endsWith(".tmpl")) return [source];
    const template = await Bun.file(source).text();
    const included = unwrapInclude(template);
    if (included !== null) return [join(await root(), included)];
    const references = templateReferences(template);
    if (references.length === 0) return [source];
    const dir = await root();
    return [source, ...references.map((reference) => join(dir, reference)).filter((path) => existsSync(path))];
  };
}

export function defaultResolver(home: string): SourceResolver {
  return Bun.which("chezmoi") === null ? identityResolver() : chezmoiResolver({ home, timeoutMs: 10_000 });
}
