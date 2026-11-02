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

  if (status.recentFailures > 0) {
    parts.push(`${status.recentFailures} Debrief${status.recentFailures > 1 ? "s" : ""} en erreur · /hindsight status`);
  }

  return parts.length === 0 ? undefined : parts.join(" · ");
}

const STATUS_MAX_AGE_MS = 60 * 60 * 1000;

let refreshedAt: number | null = null;

/** Rewrites the status line from `hindsight status`; a failure is logged, never thrown: the line is cosmetic. */
export async function refreshStatus(host: Host): Promise<void> {
  refreshedAt = await host.now();

  try {
    host.status(noticeLine(await cliStatus(host)));
  } catch (error) {
    host.log(`status failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A failure leaves the line after 24 hours, which a long session can cross with no Decision or Debrief to rewrite it. */
export async function refreshStaleStatus(host: Host): Promise<void> {
  if (refreshedAt === null || (await host.now()) - refreshedAt >= STATUS_MAX_AGE_MS) {
    await refreshStatus(host);
  }
}
