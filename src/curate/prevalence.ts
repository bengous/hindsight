import type { IsoTimestamp, Prevalence } from "../types.ts";
import { isSeedId, utcDay } from "./ids.ts";

export type Occurrence = {
  readonly sessionId: string;
  readonly repoRoot: string | null;
  readonly timestamp: IsoTimestamp;
};

export type Counted = {
  readonly prevalence: Prevalence;
  /** Distinct transcript sessions plus distinct `mem:` notes. */
  readonly sources: number;
};

/** Sessions, days and repos count transcript evidence only; an old memory note adds a source, never a session. */
export function countOccurrences(occurrences: readonly Occurrence[], fallbackAt: IsoTimestamp): Counted {
  const transcript = occurrences.filter((occurrence) => !isSeedId(occurrence.sessionId));
  const timestamps = transcript.map((occurrence) => occurrence.timestamp).toSorted();
  const repos = new Set(
    transcript.flatMap((occurrence) => (occurrence.repoRoot === null ? [] : [occurrence.repoRoot])),
  );
  return {
    prevalence: {
      sessions: new Set(transcript.map((occurrence) => occurrence.sessionId)).size,
      days: new Set(timestamps.map(utcDay)).size,
      repos: repos.size,
      firstAt: timestamps[0] ?? fallbackAt,
      lastAt: timestamps.at(-1) ?? fallbackAt,
    },
    sources: new Set(occurrences.map((occurrence) => occurrence.sessionId)).size,
  };
}
