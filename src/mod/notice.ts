import type { StatusSummary } from "./cli-client.ts";
import type { Host } from "./host.ts";

import { cliStatus } from "./cli-client.ts";

/** The status line the human sees; undefined clears it. The agent never reads it. */
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

/** Rewrites the status line from `hindsight status`; a failure is logged, never thrown: the line is cosmetic. */
export async function refreshStatus(host: Host): Promise<void> {
  try {
    host.status(noticeLine(await cliStatus(host)));
  } catch (error) {
    host.log(`status failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
