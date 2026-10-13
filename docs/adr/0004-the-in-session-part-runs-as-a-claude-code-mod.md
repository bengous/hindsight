# The in-session part runs as a Claude Code mod

The Debrief Gate and the Debrief run inside a Claude Code mod, a plugin of function hooks. At `turn.complete` on the main thread of an interactive session, the hook returns at once and a `$.clock.after` timer runs the Gate's code, then a small model through `$.model.classify` or `$.model.complete`, and, when the Gate opens, `$.model.fork`, so the session never waits for any of it. Claude Code builds the fork itself: the main thread's last request again, with its model, system prompt and tools, every tool denied and the debrief prompt appended, so the prefix comes from the session's prompt cache and `usage.cache_read_input_tokens` says how much. The Notice is a `$.ui.status` line, which Claude does not read. The mod stays thin and hands notes to the hindsight CLI, which keeps storage, Learn, Prune, commits and the Review on Bun, Effect and SQLite: a mod's module has no Node, and a hook has 10 s of its own time.

In a measured session, four detached forks read the main thread's whole prefix from cache, the first of them after a single-request turn, and a new turn started while one of them ran.

## Considered Options

- A `claude -p --resume --fork-session` process started by a Stop hook, measured over 57 runs: the fork had to keep every launch flag of the parent; `--json-schema` and any tool deny at launch lost the cache; a PreToolUse hook passed through `--settings` had to block the tools, while the human's own hooks still ran; and a fork of a single-request parent read only the shared tools and system prompt in 5 of 10 runs.
