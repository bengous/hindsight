import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { AppConfig, appLayer, printJson } from "./app.ts";
import { debrief } from "./debrief.ts";
import { gate } from "./gate.ts";
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
  Command.withSubcommands([config, debrief, gate, status]),
);

hindsight.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(appLayer),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
