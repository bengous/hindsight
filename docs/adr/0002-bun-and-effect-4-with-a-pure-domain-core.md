# Bun and Effect 4, with a pure domain core

hindsight runs on Bun with Effect 4 for every effect it performs: model calls, git, the filesystem, SQLite and the review server. Model calls need timeouts, a shared budget, bounded concurrency and a fallback to a stronger model, and one Effect `Schema` yields both the decoder and the JSON Schema passed to `claude -p --json-schema`. The domain rules themselves (gates, prevalence, quote location) stay plain pure functions so they read and test without Effect.

## Considered Options

- Plain TypeScript, as in the prototype: budget, retries and schemas written by hand twice.
- Effect 3, as in the sibling tool: a known API, but a new codebase would start one major version behind.
