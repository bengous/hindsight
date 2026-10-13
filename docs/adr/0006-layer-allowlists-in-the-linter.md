# Layer allowlists in the linter, and one owner for the Proposal contract

`src/` is a layered graph: a pure domain, adapters over it, features over the adapters, and the CLI as the composition root that nobody imports. Each folder has an allowlist of the folders it may import, and `bun run lint` holds it through `no-restricted-imports` overrides in `oxlint.config.ts`, one per folder. Specs are exempt: they import `bun:test` and `fixtures/` and cross the layers by construction.

| Folder | May import in `src/` | Note |
|---|---|---|
| `domain` | nothing | no `node:`, `bun:`, `effect` nor any package |
| `mod` | `domain` | the Claude Code runtime, plus the `claude-code` types |
| `transcripts`, `store`, `platform` | `domain` | adapters |
| `rules` | `domain`, `platform` | Rule Files only |
| `gate` | `domain`, `transcripts` | |
| `debrief` | `domain`, `transcripts`, `store`, `platform` | |
| `learn`, `review` | `domain`, `store`, `rules`, `platform` | a feature imports adapters, never another feature |
| `cli` | everything | composition root; nobody imports it |

`src/platform/` holds the shared Bun wrappers (process and git, sha1 and uuid): neither domain nor Rule Files, imported by `debrief`, `learn`, `review`, `rules` and `cli` alike.

The shape of a Proposal (`Change`, `Evidence`, `Prevalence`) has one owner each side of Effect: the flat types in `src/domain/proposal.ts`, since the domain has no Effect (ADR 0002), and the Effect Schemas with their decoders in `src/store/proposal.ts`, since the store persists these three JSON columns. `learn` and `review` import both; a spec pins each Schema's `Type` on its domain type. Application SQL lives in `src/store/queries.ts` only, as named functions on `SyncStore`; the decisions and the transactions stay in the Review port (ADR 0005).

## Considered Options

- dependency-cruiser: a second tool under Node with a native `@swc/core`, and its TypeScript range stops before the version the repository runs; it found the same two layer crossings as the oxlint overrides.
- A custom `hindsight/layers` oxlint rule that resolves each import's folder and reads the map: the same allowlist, more code; worth it if the override list grows painful or `src/` gains a level of depth.
- The Proposal Schemas in `src/learn/`, where Learn's output Schema is: `review` would then import a feature to read a row the store wrote.
