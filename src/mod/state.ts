import type { Host } from "./host.ts";
import { emptyFacts, type TurnFacts } from "../domain/facts.ts";

/** What one session accumulates between Debriefs, kept in `$.store` so that a reload or /clear loses nothing. */
export type SessionState = {
  readonly facts: TurnFacts;
  readonly lastDebriefAt: number | null;
  readonly debriefsInSession: number;
  readonly forkRunning: boolean;
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
  updatedAt: now,
});

const isState = (value: unknown): value is SessionState =>
  typeof value === "object" && value !== null && "facts" in value && "updatedAt" in value;

export async function readState(host: Host, sessionId: string, now: number): Promise<SessionState> {
  const stored = await host.storeGet(`${SESSION_PREFIX}${sessionId}`);
  return isState(stored) ? stored : freshState(now);
}

export async function writeState(host: Host, sessionId: string, state: SessionState, now: number): Promise<void> {
  await host.storeSet(`${SESSION_PREFIX}${sessionId}`, { ...state, updatedAt: now });
}

export function utcDayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function debriefsToday(host: Host, now: number): Promise<number> {
  const count = await host.storeGet(`${DAY_PREFIX}${utcDayOf(now)}`);
  return typeof count === "number" ? count : 0;
}

export async function countDebriefToday(host: Host, now: number): Promise<void> {
  await host.storeSet(`${DAY_PREFIX}${utcDayOf(now)}`, (await debriefsToday(host, now)) + 1);
}

/** Drops session states older than seven days and day counters older than two. */
export async function pruneStore(host: Host, now: number): Promise<number> {
  let dropped = 0;
  for (const key of await host.storeKeys()) {
    if (key.startsWith(SESSION_PREFIX)) {
      const value = await host.storeGet(key);
      if (!isState(value) || now - value.updatedAt > STATE_TTL_MS) {
        await host.storeDelete(key);
        dropped += 1;
      }
    } else if (key.startsWith(DAY_PREFIX)) {
      const day = new Date(`${key.slice(DAY_PREFIX.length)}T00:00:00.000Z`).getTime();
      if (!Number.isFinite(day) || now - day > DAY_TTL_MS) {
        await host.storeDelete(key);
        dropped += 1;
      }
    }
  }
  return dropped;
}
