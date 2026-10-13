import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";

import { AppConfig, appLayer, printJson } from "./app.ts";
import { debrief } from "./debrief.ts";
import { doctor } from "./doctor.ts";
import { gate } from "./gate.ts";
import { learnCommand, pruneCommand } from "./learn.ts";
import { handoff, review } from "./review.ts";
import { status } from "./status.ts";

const config = Command.make(
  "config",
  {},
  Effect.fn(function* () {
    yield* printJson(yield* AppConfig);
  }),
).pipe(Command.withDescription("Prints the effective configuration"));

const hindsight = Command.make("hindsight").pipe(
  Command.withSharedFlags({
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("One JSON line on stdout (always on)"),
      Flag.withDefault(false),
    ),
  }),
  Command.withDescription("Out-of-band upkeep of the Rule Files your agents load"),
  Command.withSubcommands([config, debrief, doctor, gate, handoff, learnCommand, pruneCommand, review, status]),
);

const mainLayer = Layer.mergeAll(appLayer, BunServices.layer);

hindsight.pipe(
  Command.run({ version: "0.1.0" }),
  // @effect-diagnostics-next-line strictEffectProvide:off -- main.ts is the CLI's entry point: the one place the application's merged Layer is provided.
  Effect.provide(mainLayer),
  BunRuntime.runMain,
);
