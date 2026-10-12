# Bun and Effect 4, with a pure domain core

The hindsight CLI runs on Bun with Effect 4 for every effect it performs: model calls, git, the filesystem, SQLite and the review server; the mod of ADR 0004 reaches Claude Code through its own API. Learn's model calls start fresh and need timeouts, a shared budget, bounded concurrency and a fallback to a stronger model, and one Effect `Schema` yields both the decoder and the JSON Schema passed to `claude -p --json-schema`: such a call has no parent cache to keep. A Debrief is a fork the mod starts and answers in text that the same `Schema` decodes. The domain rules themselves (gates, prevalence, quote location) stay plain pure functions so they read and test without Effect.

## Considered Options

- Plain TypeScript, as in the prototype: budget, retries and schemas written by hand twice.
- Effect 3, as in the sibling tool: a known API, but a new codebase would start one major version behind.
