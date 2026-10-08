# hindsight

Proposes changes to your agent rule files (`AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, output styles) from what you keep telling Claude Code, with the evidence attached, and writes nothing until you accept it.

## Why

An agent that curates its own memory while it works splits its attention between the task and the notes, and it only ever sees one session. That is how auto memory fills up with trivia that ages badly. hindsight works out of band, the way a talk by Lamis Mukta (Anthropic) describes "dreaming": a separate job with its own budget reads many sessions and the current rules together, keeps only the patterns that recur, checks them against the code, and hands each change to a human with the transcripts that support it.

## Commands

Run with `bun src/cli.ts <command>`, or `bun link` once to get `hindsight` on your PATH. It needs the `claude` CLI, logged in.

| Command | Example | What it does |
|---|---|---|
| `scan` | `hindsight scan --days 14` | Deterministic pass: session volumes, recurring tool-error clusters, stale rules (dead `paths:` globs, cited paths or scripts that are gone). No model call, no write. |
| `run` | `hindsight run --budget 5 --repo ~/Work/atelier` | Extracts steering items per session (Haiku), curates them per repository (Opus), and writes proposals to the state directory. Never touches a rule file. |
| `review` | `hindsight review` | Serves the review page on 127.0.0.1 and prints its URL. Accept, edit or reject each card; Ctrl+C stops. |
| `status` | `hindsight status` | Pending proposals, the last run and its cost. |

`hindsight --help` lists every option.

## State

Everything hindsight writes lives in `$XDG_STATE_HOME/hindsight`, else `~/.local/state/hindsight` (directories 0700, files 0600): one directory per run (proposals, extracted items, the redacted text of each cited message, costs), the extraction and curation caches, and `decisions.jsonl`, the ledger of your accepts and rejects. Transcript excerpts and message text never leave it. A commit carries only an English subject, a one-sentence lesson, the session and day counts and the run id.

## Safety model

The invariants in [AGENTS.md](AGENTS.md) are the contract. Where they bite:

- **Human gate.** A rule file changes only when you accept a card. Each accept is one commit of one file in its repository. hindsight never pushes and never runs `chezmoi apply`; it prints the command instead.
- **Human words only.** Evidence comes from text you typed. The code locates each quote verbatim in one of your messages and mints the evidence id from that message; a quote it cannot place is dropped and counted.
- **Models cannot act.** Every model call is `claude -p` without tools, MCP, hooks or session persistence, with a JSON schema for the output. The parent process does every write.
- **Exact edits.** A change is an exact replacement that must match once in a clean file. A file that changed since the proposal is still edited when the reviewed text matches; the decision records the drift. A git hook that refuses the commit leaves the file as it was.
- **Local page.** The review page listens on 127.0.0.1 with a random port and token, accepts same-origin posts only and runs no third-party script.

## Known limits

- Reads Claude Code transcripts only (`~/.claude/projects`, archives included); Codex sessions are not read.
- A paste that does not look like your own dictation is dropped, so instructions you only pasted are missed.
- Extraction with Haiku is imprecise: on a hand-labeled sample of 75 items, precision is about 0.57 under strict labeling and 0.89 under lenient labeling. The curator, the evidence gate and your review filter the rest; open a card's evidence before accepting it.
- Corrections you never voiced leave no trace in a transcript, so hindsight cannot find them.
- A repository without a local checkout gets no proposal.
