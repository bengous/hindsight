#!/usr/bin/env bun

const usage = `hindsight <command>

  scan      deterministic pass only: error clusters, stale rules, volumes (no model call)
  run       full pass: extraction, curation, proposals
  review    serve the review page for pending proposals
  status    pending proposals, last run, cost`;

const command = process.argv[2];

switch (command) {
  case undefined:
  case "help":
  case "--help":
    console.log(usage);
    break;
  default:
    console.error(`hindsight: unknown command "${command}"\n\n${usage}`);
    process.exit(2);
}
