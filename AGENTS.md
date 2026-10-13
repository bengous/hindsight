# hindsight

[SPEC.md](SPEC.md) defines the system, [GLOSSARY.md](GLOSSARY.md) its vocabulary, [docs/adr/](docs/adr/) the decisions that are hard to reverse. Where code and SPEC.md disagree, SPEC.md wins.

Out-of-band upkeep of the Rule Files coding agents load. A Claude Code mod runs the Debrief Gate at the end of a turn and forks the Debrief on the session's own prompt cache; the hindsight CLI verifies and stores the Notes, runs Learn and Prune, and takes every Decision of the Review; the mod only draws.

## Invariants

- Nothing reaches a Rule File without a human Decision through `review decide`.
- Only human-typed text can become a Quote. Tool output, peer messages, skill bodies and foreign pastes never do; the mod captures the human's own text at `prompt.submit` (origins `composer` and `bridge`) and `cleanHumanText` drops the rest.
- Nothing of hindsight enters an agent's context: `/hindsight` commands answer `{}`, `turn.complete` returns what came, no `additionalContext`. The human sees the status line, toasts and the pane; only `/hindsight handoff` fills the prompt, and the human sends it.
- The Debrief is `$.model.fork` on the session's cache; a share under the configured floor is a failed Debrief, never a cost to absorb. Learn's calls are `claude -p --json-schema` on Opus, without tools and without a fallback model.
- Evidence ids (`<sessionId>:<uuid>`) are minted by the code. A Quote must occur word for word in a Human Message of the session (the earliest is cited), an Observation must match a real tool entry by name and excerpt, a Stale Rule must match a real edit the file still holds; what fails is counted on the debrief row, never stored.
- Prevalence is computed by the code, never by a model. A rejected fingerprint returns only with more sessions than at the rejection.
- Transcript text stays in `$XDG_STATE_HOME/hindsight` (0700, database 0600). A commit message carries the subject, the lesson, the evidence counts and the proposal id, never a Quote; `applyChange` refuses a message that holds one.
- `src/domain/` imports no Node, Bun, npm or Effect module: the mod has no Node. `rg -n 'from "(node:|bun:|effect)|\bBun\.' src/domain -g '!*.spec.ts'` finds nothing.
- `src/mod/register.ts` is the only file that touches `$`; every function that receives `$` sits at its top level; the rest of `src/mod` reads a `Host`.
- Fixtures are synthetic. Never copy a real transcript line into the repo.

## Layout

- `src/domain/`: shared pure core: `TurnFacts`, Gate signals and skips, human text cleaning and markers, Debrief prompt and parser, Proposal states, config defaults, secrets masking, diff text.
- `src/mod/`: the Claude Code mod (`hooks/hooks.json` → `register.ts`), its `Host`, the CLI client, the Gate and Debrief orchestration, the Notice, the Review pane. Engine types are pinned in `types/claude-code.d.ts`; `tsconfig.mod.json` type-checks it without DOM. Kit tests are `*.test.ts` under `src/mod/` (`claude plugin test .`), excluded from `bun test`.
- `src/cli/`: `main.ts` and the Effect commands: `config`, `status`, `doctor`, `gate log|replay`, `debrief start|record`, `learn`, `prune`, `review list|decide`, `handoff prepare`. Every command prints one JSON line.
- `src/store/`: the `bun:sqlite` Store service, migrations, queries. `src/transcripts/`: JSONL reading, one session with its continuations. `src/debrief/`: verification and storage of a Debrief's answer. `src/gate/`: the replay. `src/learn/`: schema, prompt, code gates, `claude -p` runner, Learn and Prune. `src/rules/`: inventory, markdown, globs, stale checks, apply and commit. `src/review/`: the output port.
- `plans/`: session records: task checklists and follow-up prompts for an agent.
- `.claude/rules/mod.md` and `.claude/rules/cli.md` hold the path-scoped detail; this file stays the index.

## Commands

`bun test`, `claude plugin test .`, `claude plugin validate .`, `bun run typecheck`, `bun run lint`, `bun run format`. One suite: `bun test src/domain/gate.spec.ts`; one test: `bun test --test-name-pattern <regex>`. Run the CLI with `bun src/cli/main.ts <command>`; a session with the mod: `claude --plugin-dir .`, or `/reload-plugins` where the plugin is installed from this checkout.
