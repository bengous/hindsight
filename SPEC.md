# hindsight: functional specification

Terms in **bold** are defined in [GLOSSARY.md](GLOSSARY.md). Decisions that are hard to reverse live in [docs/adr/](docs/adr/).

## Purpose

hindsight keeps improving the **Rule Files** that coding agents load, from what the human expresses and what the agents notice, so that no working agent carries rule upkeep beside its own task.

## Principles

1. Nothing enters an agent's context or a session unless the human decides it.
2. **Rule Files** hold **Constraints** only. **Watch Tasks**, such as keeping rules current or noticing new conventions, are hindsight's work, done **Out of band**.
3. Evidence is either the human's own words, kept as an exact **Quote**, or an **Observation** tied to a real entry of the **Transcript**. A model's narrative alone is never evidence.
4. No **Rule** changes without a **Decision** by the human: an accepted **Proposal** becomes one change of one **Rule File**, committed when the file is in a repository, or goes into a **Handoff** the human starts.
5. What recurs across sessions outweighs what one session says. A single session yields a **Proposal** when its evidence is strong on its own: the human stated the **Steer** outright, the **Steer** contradicts a **Loaded Rule**, code proves a **Stale Rule**, or **Learn** judges an **Observation** clear enough without recurrence. Weaker evidence waits until it recurs.
6. A **Debrief** always reuses the prompt cache its session built. Rebuilding that cache is an error, never a cost to absorb.
7. Transcript content goes nowhere but the model calls hindsight makes: never into a commit, a pull request, a log or a file outside hindsight's state. A commit carries only the **Lesson**, a subject and the evidence counts, never a **Quote**.

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

- Runs at the end of every turn of the human's main interactive **Sessions** on the workstation. A **Session** started by a tool (hindsight's own forks included), a subagent, a background or a cloud session never opens it, nor does a repository the human excludes.
- Works in two steps. First, code run by hindsight at the end of the turn decides quickly whether a **Debrief** may be worth it. Only when it may, a cheap model classifier reads that result and, when needed, the last messages of the **Session**, never the whole **Session**, and decides. The code step accumulates the turn's facts since the previous **Debrief**, applies direct skips and scores signals against a threshold calibrated by replaying past **Transcripts**; every decision is journaled (ADR 0005).
- Keeps **Debriefs** rare: a **Session** with many short exchanges does not get one per turn.
- When it opens, it briefs the **Debrief** on what to look at in the turns it covers.
- Adds nothing to the **Session** and never delays the working agent.

### Debrief

- A fork of the **Session**, on the **Session**'s own model. It inherits the whole **Session** as its own context, served from the **Session**'s prompt cache, so it reads nothing again and only answers. It keeps the **Session**'s tools in its prompt but cannot run any of them.
- Covers the turns since the **Session**'s previous **Debrief**, with the whole **Session** in view.
- Answers five questions:
  1. Did your edits make a **Loaded Rule** wrong? Propose the fix.
  2. Does a new **Rule** deserve its place? State it.
  3. Which **Loaded Rule** hindered or misled you, or did you have to break?
  4. What did you have to guess for lack of a **Rule**?
  5. What did the human correct: a habit or a one-off?
- Returns **Notes**: question 1 gives suspected **Stale Rules** (each with its proposed fix); questions 2, 3 and 4 give **Observations** (each tied to the transcript entry that shows the need); question 5 gives **Steers** (each with its **Quote** and **Lesson**, marked as a habit or a one-off).
- Writes no **Rule File**. hindsight checks every **Note** before storing it: a **Quote** must occur verbatim in a **Human Message**, an **Observation** must point to a real transcript entry, and a suspected **Stale Rule** must match an edit the **Session** really made.
- Reports how much of the cache it read; a **Debrief** that rebuilt the cache is surfaced to the human as an error.

### Notes

- A **Note** is pending until **Learn** or **Prune** uses it in a **Proposal**, then used.
- A **Note** that nothing uses within the lookback window expires. The window is 30 days, configurable.

### Learn

- Starts on its own, in the background, right after the **Debrief** that brings pending **Notes** past the threshold (eight, and six hours since the previous run, both configurable). Nothing runs on a calendar. One run at a time.
- Reads pending **Steers** and **Observations** across **Sessions**, the current **Rule Files**, the **Rules** each **Session** had loaded, and the **Ledger**.
- Groups **Notes** by **Lesson**, counts **Prevalence**, and gives each group a **Verdict**: missing, ignored, misplaced, conflict, unclear or hold.
- An **Observation** can carry a **Proposal** on its own when it is clear enough; a weaker one waits until it recurs, under the **Verdict** hold.
- Never proposes a **Watch Task** as a **Rule**. When a hook or a check could carry it instead, the **Proposal** describes that change for a **Handoff**.
- Places each change by **Scope**: the global **Rule File** only when **Steers** from at least two repositories support it, or when the human stated it for every repository; otherwise the repository's **Rule Files**, path-scoped when that fits.
- Never proposes again what the **Ledger** shows as rejected, unless the evidence has clearly grown; the rejection reason informs it.

### Prune

- Never reads a **Human Message**: it acts on what a **Debrief** reports and on its own code checks.
- Turns a suspected **Stale Rule** whose edit the code confirms into a **Proposal** at once.
- On the same rhythm as **Learn**, checks every **Rule File** in code, without a model: path patterns that match no file, cited paths that are gone, cited commands that no longer exist.

### Proposals

- Each **Proposal** names its target, shown first in the **Review**: the **Rule File** of an exact text edit, or the **Rule File**, hook or setting a **Handoff** would change. It carries: the change, the evidence (**Quotes** and **Observations**, each with its **Session** and date), the **Prevalence**, the **Verdict**, the reasoning for the human in French, and the **Lesson** in English.
- A change is either an exact text edit, applied as one commit (one write for a global **Rule File** outside any repository), or a description that only a **Handoff** can carry out. A **Proposal** with a description can only be added to a **Handoff** or rejected.
- States: pending, accepted, handed off (added to a **Handoff**), rejected, superseded (a newer **Proposal** targets the same **Rule**), expired (the **Rule** changed so the edit no longer applies).

### Notice

- At the start of the human's next **Session**, a single line tells the human how many **Proposals** are pending and how to open the **Review**.
- The **Notice** is shown to the human only; the agent never sees it.

### Review

- A surface drawn on the human's machine only, behind one output port of the CLI: a pane in the Claude Code session first, a local page when one is wanted (ADR 0001).
- Shows three pending **Proposals** per pass, sorted by **Prevalence** then by age, with no quota per kind of change, each on one screen: the target, the claim, the change, the reasoning and the evidence. Each **Quote** opens onto its full **Human Message**, with secrets masked.
- Actions per **Proposal**: accept (one commit in the target repository, never pushed; for a global **Rule File** outside any repository, one write of that file), edit then accept, reject with a reason, chosen from a short list or typed, or add to a **Handoff**.
- Every **Decision**, adding a **Proposal** to a **Handoff** included, goes to the **Ledger**.

### Handoff

- The human adds **Proposals** to a **Handoff** from the **Review** and asks hindsight to prepare it.
- hindsight prepares the instructions; the human starts the agent **Session** that carries them out. hindsight never starts it.
- This is the path for changes a text edit cannot make, such as writing a hook or restructuring a **Rule File**.

## Limits of the first version

- One machine: the human's workstation.
- **Sessions** from Claude Code only.
- **Debriefs** come from the human's main interactive **Sessions** only; subagents, background and cloud sessions are outside the first version.
- Targets: the global **Rule Files**, where agents load them, and the **Rule Files** of git checkouts present on the machine; a repository without a checkout gets no **Proposal**.
- **Rule** text and commits in English; **Review**, **Notice** and reasoning in French.
- One human.

## Non-goals

- No line budget per **Rule File**.
- hindsight does not run or chain Claude Code's built-in commands (/fewer-permission-prompts, /auto-mode-setup, /insights); the human runs them when needed.
- **Prune** does not scan the git history for **Rules** that later commits made wrong; it relies on the **Debrief** and on its code checks.

## Deferred decisions

Each needs its own design session:

- A local page on the **Review**'s output port, beside the pane.
- A later convergence with the sibling tool.

Settled since the first draft, in ADR 0005 and in `AGENTS.md`: the **Debrief Gate**'s code and classifier, the thresholds of **Learn**, the size and order of a **Review** pass, and the technical design.

## Acceptance

The first version is accepted when, on the human's own **Sessions**:

1. Every **Debrief** reads its **Session**'s prompt cache instead of rebuilding it, as measured per **Debrief**.
2. No working agent's context contains anything from hindsight.
3. Every **Quote** shown in the **Review** occurs verbatim in a **Human Message** before secrets are masked, and every **Observation** points to a real transcript entry.
4. An accepted exact edit changes one **Rule File** and nothing else, as one commit when the file is in a repository; nothing is pushed.
5. A rejected **Proposal** does not come back unchanged.
6. The human judges most **Proposals** of a **Review** worth deciding, not noise. The human sets the target.
