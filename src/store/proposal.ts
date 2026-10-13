import { Schema } from "effect";

import { PROPOSAL_STATES } from "../domain/proposal.ts";

const Edit = Schema.Struct({ oldText: Schema.String, newText: Schema.String });

export const ChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("edit"), edits: Schema.Array(Edit) }),
  Schema.Struct({ kind: Schema.Literal("description"), text: Schema.String }),
]);

export const EvidenceSchema = Schema.Struct({
  evidenceId: Schema.String,
  kind: Schema.Literals(["quote", "observation"]),
  at: Schema.String,
  sessionId: Schema.String,
  text: Schema.String,
  tool: Schema.NullOr(Schema.String),
});

export const PrevalenceSchema = Schema.Struct({
  sessions: Schema.Int,
  days: Schema.Int,
  repos: Schema.Int,
  firstAt: Schema.String,
  lastAt: Schema.String,
});

export const ProposalStateSchema = Schema.Literals(PROPOSAL_STATES);

/** The three JSON columns of a `proposals` row, and its `state`, decoded as the Review reads them. */
export const decodeChange = Schema.decodeSync(Schema.fromJsonString(ChangeSchema));

export const decodeEvidence = Schema.decodeSync(Schema.fromJsonString(Schema.Array(EvidenceSchema)));

export const decodePrevalence = Schema.decodeSync(Schema.fromJsonString(PrevalenceSchema));

export const decodeState = Schema.decodeUnknownSync(ProposalStateSchema);
