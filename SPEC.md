# hindsight: functional specification

Terms in **bold** are defined in [GLOSSARY.md](GLOSSARY.md). Decisions that are hard to reverse live in [docs/adr/](docs/adr/).

## Purpose

hindsight keeps improving the **Rule Files** that coding agents load, from what the human expresses and what the agents notice, so that no working agent carries rule upkeep beside its own task.

## Principles

1. Nothing enters an agent's context or a session unless the human decides it.
2. **Rule Files** hold **Constraints** only. **Watch Tasks**, such as keeping rules current or noticing new conventions, are hindsight's work, done **Out of band**.
3. Evidence is either the human's own words, kept as an exact **Quote**, or an **Observation** tied to a real entry of the **Transcript**. A model's narrative alone is never evidence.
4. No **Rule** changes without a **Decision** by the human: an accepted **Proposal** becomes one commit, or goes into a **Handoff** the human starts.
5. What recurs across sessions outweighs what one session says. A single session yields a **Proposal** only when the human stated the **Steer** outright, when the **Steer** contradicts a **Loaded Rule**, or when code proves a **Stale Rule**.
6. A **Debrief** always reuses the prompt cache its session built. Rebuilding that cache is an error, never a cost to absorb.
7. Transcript content stays on the machine. A commit carries only the **Lesson**, a subject and the evidence counts, never a **Quote**.

## Actors

| Actor | Role |
|---|---|
| The human | works with agents, reviews **Proposals**, decides |
| The working agent | does its task in a **Session**; hindsight never adds to its context |
| The **Debrief** | a fork of the **Session** that answers fixed questions and returns **Notes** |
| hindsight | runs the **Debrief Gate**, stores **Notes**, runs **Learn** and **Prune**, shows the **Notice** and serves the **Review** |

## Flow

```
Session (the agent only does its task)
  │ end of a turn
  ▼
Debrief Gate ── closed ──► nothing happens
  │ open, with a brief of what to look at
  ▼
Debrief (fork reusing the session's cache)
  │ Notes
  ├─ Steers, Observations ──► pending Notes ──(enough matter)──► Learn ──┐
  └─ suspected Stale Rules ──(code confirms the edit)──────────► Prune ──┤
                                                                         ▼
                                                                pending Proposals
                                                                         │ Notice at the next session start
                                                                         ▼
                                                                      Review
                                                     accept → commit │ handoff → agent session the human starts
                                                     reject + reason → Ledger
```

## Behaviors

### Debrief Gate

- Runs at the end of every turn of every **Session**, except **Sessions** started non-interactively by a tool, **Sessions** in a scratch directory, and repositories the human excludes.
- Applies deterministic rules first, then a cheap model judgment. Both are specified separately (see Deferred decisions).
- When it opens, it briefs the **Debrief** on what to look at in the turns it covers.
- Adds nothing to the **Session** and never delays the working agent.

### Debrief

- A fork of the **Session**, on the **Session**'s own model, that reuses the **Session**'s prompt cache. It keeps the **Session**'s tools in its prompt but cannot run any of them.
- Covers the turns since the **Session**'s previous **Debrief**, with the whole **Session** in view.
- Answers five questions:
  1. Did your edits make a **Loaded Rule** wrong? Propose the fix.
  2. Does a new **Rule** deserve its place? State it.
  3. Which **Loaded Rule** hindered or misled you, or did you have to break?
  4. What did you have to guess for lack of a **Rule**?
  5. What did the human correct: a habit or a one-off?
- Returns **Notes**: **Steers** (each with its **Quote** and **Lesson**), **Observations** (each tied to a transcript entry), suspected **Stale Rules** (each with its proposed fix).
- Writes no **Rule File**. hindsight checks every **Note** before storing it: a **Quote** must occur verbatim in a **Human Message**, an **Observation** must point to a real transcript entry, and a suspected **Stale Rule** must match an edit the **Session** really made.
- Reports how much of the cache it read; a **Debrief** that rebuilt the cache is surfaced to the human as an error.

### Notes

- A **Note** is pending until **Learn** or **Prune** uses it in a **Proposal**, then used.
- A **Note** that nothing uses within the lookback window expires.

### Learn

- Starts on its own, in the background, right after the **Debrief** that brings pending **Notes** past the threshold. Nothing runs on a calendar.
- Reads pending **Steers** and **Observations** across **Sessions**, the current **Rule Files**, the **Rules** each **Session** had loaded, and the **Ledger**.
- Groups **Notes** by **Lesson**, counts **Prevalence**, and gives each group a **Verdict**: missing, ignored, misplaced, conflict or hold.
- An **Observation** can support a **Proposal** but never carries one alone.
- Places each change by **Scope**: the global **Rule File** only when **Steers** from at least two repositories support it, or when the human stated it for every repository; otherwise the repository's **Rule Files**, path-scoped when that fits.
- Never proposes again what the **Ledger** shows as rejected, unless the evidence has clearly grown; the rejection reason informs it.

### Prune

- Reads the code and its history, never a **Human Message**.
- Turns a suspected **Stale Rule** whose edit the code confirms into a **Proposal** at once.
- On the same rhythm as **Learn**, checks every **Rule File** mechanically: path patterns that match no file, cited paths that are gone, cited commands that no longer exist.

### Proposals

- Each **Proposal** targets one **Rule File** and carries: the change, the evidence (**Quotes** and **Observations**, each with its **Session** and date), the **Prevalence**, the **Verdict**, the reasoning for the human in French, and the **Lesson** in English.
- A change is either an exact text edit, applied as one commit, or a description that only a **Handoff** can carry out.
- States: pending, accepted, rejected, superseded (a newer **Proposal** targets the same **Rule**), expired (the **Rule** changed so the edit no longer applies).

### Notice

- At the start of the human's next **Session**, a single line tells the human how many **Proposals** are pending and how to open the **Review**.
- The **Notice** is shown to the human only; the agent never sees it.

### Review

- A page served on the human's machine only.
- Shows a few pending **Proposals** at a time, strongest first, each on one screen: the claim, the change, the reasoning and the evidence. Each **Quote** opens onto its full **Human Message**, with secrets masked.
- Actions per **Proposal**: accept (one commit in the target repository, never pushed), edit then accept, reject with a reason, or add to a **Handoff**.
- Every **Decision** goes to the **Ledger**.

### Handoff

- The human selects accepted **Proposals** and asks hindsight to prepare a **Handoff** for them.
- hindsight prepares the instructions; the human starts the agent **Session** that carries them out. hindsight never starts it.
- This is the path for changes a text edit cannot make, such as writing a hook or restructuring a **Rule File**.

## Limits of the first version

- One machine: the human's workstation.
- **Sessions** from Claude Code only.
- Targets: **Rule Files** in a git checkout present on the machine; a repository without a checkout gets no **Proposal**.
- **Rule** text and commits in English; **Review**, **Notice** and reasoning in French.
- One human.

## Deferred decisions

Each needs its own design session:

- The **Debrief Gate**'s deterministic rules and model judgment.
- The threshold of pending **Notes** that starts **Learn**, and the lookback window.
- How many **Proposals** the **Review** shows at once.
- The technical design: modules, storage schema, process model.
- A later convergence with the sibling tool.

## Acceptance

The first version is accepted when, on the human's own **Sessions**:

1. Every **Debrief** reads its **Session**'s prompt cache instead of rebuilding it, as measured per **Debrief**.
2. No working agent's context contains anything from hindsight.
3. Every **Quote** shown in the **Review** occurs verbatim in a **Human Message**, and every **Observation** points to a real transcript entry.
4. An accepted exact edit becomes one commit of one **Rule File** and nothing else; nothing is pushed.
5. A rejected **Proposal** does not come back unchanged.
6. The human judges most **Proposals** of a **Review** worth deciding, not noise. The human sets the target.
