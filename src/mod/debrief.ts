import type { Host } from "./host.ts";
import type { ModelForkResult } from "claude-code";
import { debriefPrompt } from "../domain/debrief.ts";
import { cliDebriefRecord, cliDebriefStart, type RecordAnswer } from "./cli-client.ts";

export type DebriefRun =
  | { readonly kind: "recorded"; readonly answer: RecordAnswer; readonly cacheShare: number }
  | { readonly kind: "failed"; readonly answer: RecordAnswer; readonly cacheShare: number }
  | { readonly kind: "aborted"; readonly reason: string };

/** How much of the fork's prompt the cache served: the part not read is uncached input or a cache write. */
export function cacheShareOf(result: Extract<ModelForkResult, { isAnswered: true }>): number {
  const usage = result.usage;
  const read = usage.cache_read_input_tokens ?? 0;
  const total = read + usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
  return total === 0 ? 0 : read / total;
}

/** Opens the row, forks on the session's cache, measures, records: the CLI judges what holds. */
export async function runDebrief(
  host: Host,
  sessionId: string,
  repoRoot: string | null,
  brief: string,
): Promise<DebriefRun> {
  const id = await cliDebriefStart(host, sessionId, repoRoot);
  const startedAt = await host.now();
  const result = await host.fork(debriefPrompt(brief));
  const durationMs = (await host.now()) - startedAt;
  if (!result.isAnswered) {
    const body = { sessionId, cacheShare: 0, durationMs, text: "", repoRoot };
    if (result.reason === "aborted" || result.reason === "nothing-to-fork") {
      void cliDebriefRecord(host, id, { ...body, text: `[fork ${result.reason}]` }).catch(() => undefined);
      return { kind: "aborted", reason: result.reason };
    }
    const detail = result.reason === "api-error" ? `api-error ${result.status}` : result.reason;
    const answer = await cliDebriefRecord(host, id, { ...body, text: `[fork ${detail}]` });
    return { kind: "failed", answer, cacheShare: 0 };
  }
  const cacheShare = cacheShareOf(result);
  const answer = await cliDebriefRecord(host, id, { sessionId, cacheShare, durationMs, text: result.text, repoRoot });
  return answer.status === "recorded"
    ? { kind: "recorded", answer, cacheShare }
    : { kind: "failed", answer, cacheShare };
}

export function debriefToast(run: DebriefRun): string | null {
  switch (run.kind) {
    case "recorded": {
      const { steers, observations, staleRules } = run.answer.notes;
      const total = steers + observations + staleRules;
      const rejected = Object.values(run.answer.rejected).reduce((sum, n) => sum + n, 0);
      if (total === 0 && rejected === 0) return null;
      return `Debrief : ${total} Note(s) retenue(s)${rejected > 0 ? `, ${rejected} rejetée(s)` : ""}${run.answer.proposals > 0 ? `, ${run.answer.proposals} Proposal(s)` : ""}`;
    }
    case "failed":
      return `Debrief en erreur : ${run.answer.failure ?? "inconnue"} (cache ${Math.round(run.cacheShare * 100)} %)`;
    case "aborted":
      return null;
    default:
      return null;
  }
}
