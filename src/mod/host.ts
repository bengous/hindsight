import type { JsonValue } from "../domain/json.ts";
import type { ModelForkResult, ProcessRunInit, ProcessRunResult, SessionMessage } from "claude-code";

/** What the mod's logic needs from the engine, built from `$` in register.ts alone so that bun:test can fake it. */
export type Host = {
  readonly pluginRoot: string;
  readonly now: () => Promise<number>;
  readonly sessionId: () => Promise<string>;
  readonly repoRoot: () => Promise<string | null>;
  readonly messages: () => Promise<readonly SessionMessage[]>;
  readonly storeGet: (key: string) => Promise<JsonValue | undefined>;
  readonly storeSet: (key: string, value: JsonValue) => Promise<void>;
  readonly storeDelete: (key: string) => Promise<void>;
  readonly storeKeys: () => Promise<readonly string[]>;
  readonly run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>;
  readonly classify: (text: string, labels: readonly string[], model: string | null) => Promise<string | undefined>;
  readonly fork: (prompt: string) => Promise<ModelForkResult>;
  readonly after: (ms: number, fn: () => void) => void;
  readonly status: (text: string | undefined) => void;
  readonly toast: (text: string) => void;
  readonly log: (text: string) => void;
  readonly fill: (text: string) => Promise<void>;
};
