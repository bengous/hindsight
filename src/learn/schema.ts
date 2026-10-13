import type { JsonSchema } from "effect";

import { Schema } from "effect";

import { VERDICTS } from "../domain/proposal.ts";
import { ChangeSchema } from "../store/proposal.ts";

export const CandidateSchema = Schema.Struct({
  verdict: Schema.Literals(VERDICTS),
  scope: Schema.Literals(["global", "repo", "path"]),
  targetPath: Schema.String,
  noteIds: Schema.Array(Schema.String),
  ruleBulletIds: Schema.Array(Schema.String),
  claimFr: Schema.String,
  reasoningFr: Schema.String,
  lessonEn: Schema.String,
  subjectEn: Schema.String,
  change: ChangeSchema,
  isWatchTask: Schema.Boolean,
  singleSessionJustification: Schema.NullOr(Schema.String),
});

export const LearnOutputSchema = Schema.Struct({ candidates: Schema.Array(CandidateSchema) });

export type LearnOutput = typeof LearnOutputSchema.Type;

export type Candidate = typeof CandidateSchema.Type;

export const decodeLearnOutput = Schema.decodeUnknownSync(LearnOutputSchema);

/** The JSON Schema `claude -p --json-schema` receives, derived from the same Schema that decodes the answer. */
export function learnJsonSchema(): JsonSchema.JsonSchema {
  return Schema.toJsonSchemaDocument(LearnOutputSchema, { onExcessProperty: "error" }).schema;
}
