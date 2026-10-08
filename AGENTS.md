# hindsight

[SPEC.md](SPEC.md) defines the target system, [GLOSSARY.md](GLOSSARY.md) its vocabulary, [docs/adr/](docs/adr/) the decisions that are hard to reverse. `src/` holds the prototype described below; where the two disagree, SPEC.md wins.

Out-of-band curation of agent rules. `hindsight run` reads recent Claude Code transcripts and the current rule files (AGENTS.md, CLAUDE.md, `.claude/rules/`), finds patterns that recur across sessions, verifies them against the code, and writes proposals with evidence. `hindsight review` serves a local page where the human accepts or rejects each proposal; an accepted proposal becomes one git commit in the target repo.

## Invariants

- Nothing reaches a rule file without a human decision on the review page.
- Only human-typed text can become a correction. Tool output, peer messages, skill bodies and foreign pastes never do.
- Model calls that start fresh (the Debrief Gate's classifier, Learn) are pure I/O (`claude -p`, no tools, JSON schema out). A Debrief is the exception: it keeps its session's model, tools and system prompt, a hook blocks every tool call, and it answers in text. The parent process owns every write.
- Evidence ids (`<sessionId>:<uuid>`, `mem:<path>`) are minted by the code. An extracted quote must be a verbatim substring of a human message of its batch: the code locates it and cites that message, the earliest when the human repeated it. An item whose quote matches no message is dropped and counted. A curator output citing an unknown id fails the batch.
- Prevalence is computed by the code, never by a model.
- Transcript excerpts stay in `~/.local/state/hindsight/` (mode 0700). They never reach a commit, a fixture or a log outside it.
- Fixtures are synthetic. Never copy a real transcript line into the repo.

## Layout

`src/types.ts` holds the contracts between modules. Each directory under `src/` owns one stage: `transcripts/` (reading), `signals/` (deterministic features and error clusters), `rules/` (inventory, stale scan, apply), `model/` (the `claude -p` runner), `curate/` (extraction, clustering, evidence gate), `state/`, `review/` (the page).

## Commands

`bun test`, `bun run typecheck`, `bun run lint`, `bun run format`.
