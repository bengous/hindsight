import { Effect, Schema } from "effect";
import { Command } from "effect/cli";

import { decideProposal, listReview, prepareHandoff } from "../review/port.ts";
import { AppConfig, printJson, readStdin } from "./app.ts";

const EditSchema = Schema.Struct({ oldText: Schema.String, newText: Schema.String });

const DecideStdin = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    decision: Schema.Literal("accept"),
    edits: Schema.NullOr(Schema.Array(EditSchema)),
  }),
  Schema.Struct({ id: Schema.String, decision: Schema.Literal("reject"), reason: Schema.String }),
  Schema.Struct({ id: Schema.String, decision: Schema.Literal("handoff") }),
]);

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const config = yield* AppConfig;
    yield* printJson(yield* listReview(config));
  }),
).pipe(Command.withDescription("The pending Proposals of one Review pass, settled and sorted"));

const decide = Command.make(
  "decide",
  {},
  Effect.fn(function* () {
    const input = yield* Schema.decodeUnknownEffect(DecideStdin)(JSON.parse(yield* readStdin));

    const decision =
      input.decision === "accept"
        ? ({ kind: "accept", edits: input.edits } as const)
        : input.decision === "reject"
          ? ({ kind: "reject", reason: input.reason } as const)
          : ({ kind: "handoff" } as const);

    yield* printJson(yield* decideProposal(input.id, decision));
  }),
).pipe(Command.withDescription("Takes one Decision read on stdin: accept, reject with a reason, or handoff"));

export const review = Command.make("review").pipe(
  Command.withDescription("The Review's output port: list and decide"),
  Command.withSubcommands([list, decide]),
);

const prepare = Command.make(
  "prepare",
  {},
  Effect.fn(function* () {
    yield* printJson(yield* prepareHandoff());
  }),
).pipe(Command.withDescription("Writes the instructions of the handed-off Proposals, without any Quote"));

export const handoff = Command.make("handoff").pipe(
  Command.withDescription("Proposals the human gives to an agent session"),
  Command.withSubcommands([prepare]),
);
