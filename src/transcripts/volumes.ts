import type { CollectResult, CollectStats } from "./collect.ts";

export type RepoVolume = {
  readonly repoRoot: string | null;
  readonly sessions: number;
  readonly humanMessages: number;
  readonly errorEvents: number;
  readonly errorSessions: number;
};

export type Volumes = {
  readonly totals: { readonly sessions: number; readonly humanMessages: number; readonly errorEvents: number };
  /** Sorted by human messages, then error events. */
  readonly byRepo: readonly RepoVolume[];
  readonly stats: CollectStats;
};

type Tally = { sessions: number; humanMessages: number; errorEvents: number; errorSessions: Set<string> };

export function volumes(result: CollectResult): Volumes {
  const tallies = new Map<string | null, Tally>();
  const tally = (repoRoot: string | null): Tally => {
    const known = tallies.get(repoRoot);
    if (known !== undefined) return known;
    const fresh: Tally = { sessions: 0, humanMessages: 0, errorEvents: 0, errorSessions: new Set() };
    tallies.set(repoRoot, fresh);
    return fresh;
  };
  for (const digest of result.digests) {
    const entry = tally(digest.repoRoot);
    entry.sessions += 1;
    entry.humanMessages += digest.messages.length;
  }
  for (const event of result.errors) {
    const entry = tally(event.repoRoot);
    entry.errorEvents += 1;
    entry.errorSessions.add(event.sessionId);
  }
  const byRepo = [...tallies]
    .map(([repoRoot, entry]) => ({
      repoRoot,
      sessions: entry.sessions,
      humanMessages: entry.humanMessages,
      errorEvents: entry.errorEvents,
      errorSessions: entry.errorSessions.size,
    }))
    .sort((a, b) => b.humanMessages - a.humanMessages || b.errorEvents - a.errorEvents);
  return {
    totals: {
      sessions: result.digests.length,
      humanMessages: result.stats.humanMessages,
      errorEvents: result.errors.length,
    },
    byRepo,
    stats: result.stats,
  };
}
