import type { HindsightConfig } from "../domain/config.ts";
import type { JsonValue } from "../domain/json.ts";
import type { Store } from "../store/db.ts";
import type { Paths } from "../store/paths.ts";

import { Context, Effect, Layer } from "effect";
import { existsSync, readFileSync } from "node:fs";

import { readConfig } from "../domain/config.ts";
import { parseJson } from "../domain/json.ts";
import { storeLayer } from "../store/db.ts";
import { hindsightPaths } from "../store/paths.ts";

export class AppPaths extends Context.Service<AppPaths, Paths>()("hindsight/cli/app/AppPaths") {}

export class AppConfig extends Context.Service<AppConfig, HindsightConfig>()("hindsight/cli/app/AppConfig") {}

export function loadConfig(configPath: string): HindsightConfig {
  if (!existsSync(configPath)) {
    return readConfig(undefined);
  }

  let parsed: JsonValue;

  try {
    parsed = parseJson(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`${configPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  return readConfig(parsed);
}

export const pathsLayer = Layer.succeed(AppPaths, hindsightPaths());

export const configLayer: Layer.Layer<AppConfig, never, AppPaths> = Layer.effect(
  AppConfig,
  Effect.map(AppPaths, (paths) => loadConfig(paths.configPath)),
);

export const appLayer = Layer.mergeAll(
  configLayer,
  Layer.unwrap(Effect.map(AppPaths, (paths) => storeLayer(paths.dbPath))),
).pipe(Layer.provideMerge(pathsLayer));

export type App = AppPaths | AppConfig | Store;

export const printJson = (value: JsonValue): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });

export const readStdin: Effect.Effect<string> = Effect.promise(async () => Bun.stdin.text());

export const nowIso = (): string => new Date().toISOString();
