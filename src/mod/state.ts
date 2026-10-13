import type { TurnFacts } from "../domain/facts.ts";
import type { JsonValue } from "../domain/json.ts";
import type { Host } from "./host.ts";

import { emptyFacts } from "../domain/facts.ts";
import { isJsonObject, isNumber } from "../domain/json.ts";

/** What one session accumulates between Debriefs, kept in `$.store` so that a reload or /clear loses nothing. */
export type SessionState = {
  readonly facts: TurnFacts;
  readonly lastDebriefAt: number | null;
  readonly debriefsInSession: number;
  readonly forkRunning: boolean;
  readonly forkStartedAt: number | null;
  readonly updatedAt: number;
};

const SESSION_PREFIX = "session:";

const DAY_PREFIX = "day:";

const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export const freshState = (now: number): SessionState => ({
  facts: emptyFacts,
  lastDebriefAt: null,
  debriefsInSession: 0,
  forkRunning: false,
  forkStartedAt: null,
  updatedAt: now,
});

const isState = (value: JsonValue | undefined): value is SessionState =>
  isJsonObject(value) &&
  isJsonObject(value["facts"]) &&
  (value["lastDebriefAt"] === null || isNumber(value["lastDebriefAt"])) &&
  isNumber(value["debriefsInSession"]) &&
  typeof value["forkRunning"] === "boolean" &&
  (value["forkStartedAt"] === null || isNumber(value["forkStartedAt"])) &&
  isNumber(value["updatedAt"]);

export const FORK_STALE_MS = 15 * 60 * 1000;

/** A fork lock older than fifteen minutes belongs to a fork the engine lost: it no longer holds. */
export async function readState(host: Host, sessionId: string, now: number): Promise<SessionState> {
  const stored = await host.storeGet(`${SESSION_PREFIX}${sessionId}`);

  if (!isState(stored)) {
    return freshState(now);
  }

  const startedAt = stored.forkStartedAt;

  if (stored.forkRunning && (startedAt === null || now - startedAt > FORK_STALE_MS)) {
    return { ...stored, forkRunning: false, forkStartedAt: null };
  }

  return stored;
}

/** What the Debrief did not see: the facts added while it ran. */
export function factsSince(current: TurnFacts, snapshot: TurnFacts): TurnFacts {
  return {
    humanTexts: current.humanTexts.slice(snapshot.humanTexts.length),
    edits: current.edits.slice(snapshot.edits.length),
    toolCalls: Math.max(0, current.toolCalls - snapshot.toolCalls),
    toolErrors: Math.max(0, current.toolErrors - snapshot.toolErrors),
    refusedTools: current.refusedTools.slice(snapshot.refusedTools.length),
    gitCommits: Math.max(0, current.gitCommits - snapshot.gitCommits),
    afterInterrupt: current.afterInterrupt,
    prompts: Math.max(0, current.prompts - snapshot.prompts),
  };
}

export async function writeState(host: Host, sessionId: string, state: SessionState, now: number): Promise<void> {
  await host.storeSet(`${SESSION_PREFIX}${sessionId}`, { ...state, updatedAt: now });
}

const queues = new Map<string, Promise<unknown>>();

/** `$.store` has no versions: the mod's read-modify-writes of one session run one after the other. */
async function exclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();

  const run = (async (): Promise<T> => {
    await previous;

    return fn();
  })();

  queues.set(sessionId, Promise.allSettled([run]));

  return run;
}

export async function changeState(
  host: Host,
  sessionId: string,
  now: number,
  change: (state: SessionState) => SessionState,
): Promise<SessionState> {
  return exclusive(sessionId, async () => {
    const next = change(await readState(host, sessionId, now));
    await writeState(host, sessionId, next, now);

    return next;
  });
}

/** Takes the session's fork lock and answers the state as locked, or null while another fork holds it. */
export async function takeFork(host: Host, sessionId: string, now: number): Promise<SessionState | null> {
  return exclusive(sessionId, async () => {
    const state = await readState(host, sessionId, now);

    if (state.forkRunning) {
      return null;
    }

    const locked = { ...state, forkRunning: true, forkStartedAt: now };
    await writeState(host, sessionId, locked, now);

    return locked;
  });
}

export function utcDayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function debriefsToday(host: Host, now: number): Promise<number> {
  const count = await host.storeGet(`${DAY_PREFIX}${utcDayOf(now)}`);

  return isNumber(count) ? count : 0;
}

export async function countDebriefToday(host: Host, now: number): Promise<void> {
  await host.storeSet(`${DAY_PREFIX}${utcDayOf(now)}`, (await debriefsToday(host, now)) + 1);
}

/** Drops session states older than seven days and day counters older than two. */
export async function pruneStore(host: Host, now: number): Promise<number> {
  const isExpired = async (key: string): Promise<boolean> => {
    if (key.startsWith(SESSION_PREFIX)) {
      const value = await host.storeGet(key);

      return !isState(value) || now - value.updatedAt > STATE_TTL_MS;
    }

    if (key.startsWith(DAY_PREFIX)) {
      const day = new Date(`${key.slice(DAY_PREFIX.length)}T00:00:00.000Z`).getTime();

      return !Number.isFinite(day) || now - day > DAY_TTL_MS;
    }

    return false;
  };

  const keys = await host.storeKeys();
  const expired = await Promise.all(keys.map(isExpired));
  const dropped = keys.filter((_, index) => expired[index] === true);
  await Promise.all(dropped.map(async (key) => host.storeDelete(key)));

  return dropped.length;
}
