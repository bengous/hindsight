# A code Gate with a journal, a Review behind an output port, and Learn on Opus without a fallback

The Debrief Gate is code first. At the end of a turn the mod accumulates `TurnFacts` since the session's previous Debrief (the human's own text captured at `prompt.submit`, the turn's tool uses, errors, refusals, commits), applies the direct skips (non-interactive session, subagent, aborted turn, fork running, excluded repository, cooldown, quiet turn, daily cap), scores the signals (a correction or standing-instruction marker, a refused tool, a message after an interrupt, a Rule File edit at 1; many edits, tool errors, a commit at 0.5) against a threshold, and only then asks a small model to classify `debrief` or `skip`. Every decision goes to the `gate_decisions` journal, and `gate replay` recomputes the same facts from past transcripts, so the thresholds are calibrated on the human's own history instead of fixed in advance. The replay builds each turn's facts as the mod does, carrying them from the previous pass, so a marker that reads the earlier prompts counts the same on both sides. The current values live in `src/domain/config.ts`; each replay and the move it justified are session records under `plans/`.

The Review's decisions live in the CLI behind one port: `review list` settles and sorts the pending Proposals, `review decide` applies, rejects or hands off, `handoff prepare` writes the instructions. The pane only draws what the port returns and sends back what the human pressed; a page would do the same.

Learn runs on Opus through `claude -p --json-schema`, one call per scope, under a budget per run, and with no fallback model: a weaker model proposing rules is worse than no proposal, and the Debrief's Notes keep until the next run.

## Considered Options

- A model-first Gate, as the sibling tool tried: a cumulative score opened four forks in five minutes, and nothing told why.
- Decisions taken in the pane: a page would then need the logic twice.
- Learn with a fallback to a cheaper model when Opus fails: hides the failure and lowers the quality of what the human reviews.
