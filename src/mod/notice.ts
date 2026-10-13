import type { StatusSummary } from "./cli-client.ts";

/** The one line the human sees at session start; undefined clears it. The agent never reads it. */
export function noticeLine(status: StatusSummary): string | undefined {
  const parts: string[] = [];

  if (status.pendingProposals > 0) {
    parts.push(
      `${status.pendingProposals} Proposal${status.pendingProposals > 1 ? "s" : ""} en attente · /hindsight review`,
    );
  }

  if (status.failures > 0) {
    parts.push(`${status.failures} Debrief${status.failures > 1 ? "s" : ""} en erreur · /hindsight status`);
  }

  return parts.length === 0 ? undefined : parts.join(" · ");
}
