import type { ApplyRefusal, ApplyRequest, ApplyResult } from "../rules/apply.ts";
import type { PendingProposal } from "../state/index.ts";
import type { Decision, DeltaOp } from "../types.ts";
import type { DecisionReply, DecisionRequest } from "./client.ts";

export type DecisionDeps = {
  readonly apply: (request: ApplyRequest) => Promise<ApplyResult>;
  readonly record: (decision: Decision) => Promise<void>;
  /** Deployed file the agents load for a source, when it differs from the source (a chezmoi target). */
  readonly deployedPath: (sourcePath: string) => Promise<string | null>;
  readonly now: () => Date;
};

export type RequestCheck =
  | { readonly ok: true; readonly request: DecisionRequest; readonly target: PendingProposal }
  | { readonly ok: false; readonly error: string };

const MAX_REASON_CHARS = 500;

const refusalText: Record<ApplyRefusal, string> = {
  "no-checkout": "aucun dépôt git ne contient ce fichier",
  "outside-checkout": "le fichier est hors du dépôt cible",
  "invalid-op": "la modification proposée est invalide",
  "excerpt-in-message": "le message de commit contiendrait une citation de transcript",
  "file-exists": "le fichier à créer existe déjà",
  "ignored-path": "git ignore le fichier à créer",
  "hash-mismatch": "le fichier a changé depuis la proposition, relance hindsight run",
  "dirty-file": "le fichier a des modifications non commitées",
  "old-text-missing": "le texte à remplacer est introuvable",
  "old-text-ambiguous": "le texte à remplacer apparaît plusieurs fois",
  "commit-rejected": "un hook git a refusé le commit",
};

/** Validates a POSTed body against the pending proposal it targets. */
export function checkRequest(body: unknown, pending: ReadonlyMap<string, PendingProposal>): RequestCheck {
  if (typeof body !== "object" || body === null) return { ok: false, error: "corps JSON attendu" };
  const fingerprint = "fingerprint" in body ? body.fingerprint : undefined;
  const decision = "decision" in body ? body.decision : undefined;
  const reason = "reason" in body ? body.reason : undefined;
  const newTexts = "newTexts" in body ? body.newTexts : undefined;
  if (typeof fingerprint !== "string") return { ok: false, error: "fingerprint manquant" };
  const target = pending.get(fingerprint);
  if (target === undefined) return { ok: false, error: "proposition introuvable ou déjà décidée" };

  if (decision === "rejected") {
    if (typeof reason !== "string" || reason.trim() === "") return { ok: false, error: "une raison est requise" };
    if (reason.length > MAX_REASON_CHARS)
      return { ok: false, error: `raison limitée à ${MAX_REASON_CHARS} caractères` };
    if (newTexts !== null) return { ok: false, error: "un rejet ne porte pas de texte modifié" };
    return { ok: true, target, request: { fingerprint, decision, reason: reason.trim(), newTexts: null } };
  }
  if (decision !== "accepted") return { ok: false, error: "décision inconnue" };
  if (reason !== null) return { ok: false, error: "une acceptation ne porte pas de raison" };
  if (newTexts === null) return { ok: true, target, request: { fingerprint, decision, reason: null, newTexts: null } };
  const edits = target.proposal.op?.edits.length ?? 0;
  if (!Array.isArray(newTexts) || newTexts.length !== edits || newTexts.some((text) => typeof text !== "string")) {
    return { ok: false, error: `texte modifié attendu pour ${edits} remplacement(s)` };
  }
  return { ok: true, target, request: { fingerprint, decision, reason: null, newTexts: newTexts.map(String) } };
}

function withNewTexts(op: DeltaOp, newTexts: readonly string[]): DeltaOp {
  return {
    ...op,
    edits: op.edits.map((edit, index) => ({ oldText: edit.oldText, newText: newTexts[index] ?? edit.newText })),
  };
}

/** Accepting an op commits it before the decision is recorded; a refused apply records nothing and keeps the card pending. */
export async function decide(
  pending: PendingProposal,
  request: DecisionRequest,
  deps: DecisionDeps,
): Promise<DecisionReply> {
  const { proposal, runId } = pending;
  const base = { proposalId: proposal.id, fingerprint: proposal.fingerprint, runId, at: deps.now().toISOString() };

  if (request.decision === "rejected") {
    await deps.record({ ...base, decision: "rejected", editedOp: null, reason: request.reason, commit: null });
    return { ok: true, commit: null, followUp: [] };
  }
  if (proposal.op === null) {
    await deps.record({ ...base, decision: "accepted", editedOp: null, reason: null, commit: null });
    return { ok: true, commit: null, followUp: [] };
  }

  const op = request.newTexts === null ? proposal.op : withNewTexts(proposal.op, request.newTexts);
  const result = await deps.apply({
    runId,
    repoRoot: proposal.target.repoRoot,
    blobHash: proposal.target.blobHash,
    op,
    deployedPath: await deps.deployedPath(op.sourcePath),
    subject: proposal.commitSubject,
    why: proposal.lesson,
    prevalence: proposal.prevalence,
    excerpts: proposal.evidence.map((item) => item.quote),
  });
  if (result.kind === "refused") return { ok: false, error: `${refusalText[result.reason]} (${result.detail})` };

  const editedOp = request.newTexts === null ? null : op;
  try {
    await deps.record({ ...base, decision: "accepted", editedOp, reason: null, commit: result.commit });
  } catch (error) {
    throw new Error(`commit ${result.commit} is in ${proposal.target.repoRoot}, but the decision was not recorded`, {
      cause: error,
    });
  }
  return { ok: true, commit: result.commit, followUp: result.followUp };
}
