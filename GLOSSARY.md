# hindsight

Out-of-band curation of the rules that coding agents load. It reads what the human said across many sessions and proposes reviewed changes to rule files, so that no working agent carries rule upkeep beside its own task.

## Language

### Sessions and what the human says

**Session**:
One conversation between the human and a coding agent, possibly recorded in several transcript files linked by continuation.
_Avoid_: conversation, chat, thread

**Transcript**:
A file that records all or part of a session.
_Avoid_: log, history

**Human Message**:
Text the human typed in a session. Text that the harness, tools, plugins or other agents inject, and text the human pasted from another source, is not a human message.
_Avoid_: user message, prompt

**Quote**:
An exact excerpt of one human message, kept as evidence.
_Avoid_: excerpt, citation

**Steer**:
A way of working the human expressed in a session, either stated outright (explicit) or implied by a correction (inferred). A steer carries a quote and a lesson.
_Avoid_: directive, correction, steering item, item, memory

**Lesson**:
One general sentence stating the way of working a steer implies.
_Avoid_: rule (a lesson becomes a rule only once a proposal is accepted), insight, takeaway

### Rules

**Rule File**:
A file an agent loads as standing guidance: an AGENTS.md, a CLAUDE.md, a path-scoped rule file or an output style.
_Avoid_: memory, docs, instructions file

**Rule**:
One statement inside a rule file.
_Avoid_: bullet, guideline, instruction

**Scope**:
Where a rule applies: global (every repository), repository, or path (the files that match the rule file's path patterns).

**Loaded Rule**:
A rule that was in the agent's context at a given moment of a session.

**Stale Rule**:
A rule that no longer matches the code or the human's current wishes.
_Avoid_: outdated rule, dead rule, drift (chezmoi uses the word for target drift)

**Constraint**:
Guidance that acts on something the agent does anyway, such as how to word a commit or what a doc may contain. Constraints belong in rule files.
_Avoid_: policy, guard

**Watch Task**:
Guidance that asks the agent to look out for something beside its task, such as keeping docs current or noticing new conventions. Watch tasks do not belong in rule files; hindsight carries them out of band.
_Avoid_: chore, maintenance instruction, vigilance rule

### Judgment

**Prevalence**:
How widely something recurs, counted in distinct sessions, days and repositories.
_Avoid_: frequency, count, hits

**Out of band**:
Done outside every working agent's session, with its own budget, so that no working agent carries any part of it.
_Avoid_: background, async

**Verdict**:
How a recurring steer relates to the rules: missing (no rule states it), ignored (a loaded rule states it and the agent broke it), misplaced (a rule states it but did not load when needed), conflict (the steer contradicts a rule), or hold (too weak to act on yet).
_Avoid_: watch (as a verdict), finding kind, classification

### Jobs

**Learn**:
The job that reads steers and proposes to add, change or relocate rules, including a rule the human now contradicts.
_Avoid_: harvest, extraction, dreaming

**Prune**:
The job that reads the code and its history, never the human's messages, and proposes to fix or remove the rules it has made stale.
_Avoid_: cleanup, audit, recheck

### Review

**Proposal**:
One reviewable change to one rule file, with its evidence and its reasoning.
_Avoid_: card (the review page's display of a proposal), suggestion, candidate, finding

**Decision**:
The human's acceptance or rejection of a proposal; a rejection carries a reason.

**Ledger**:
The record of every decision, which keeps hindsight from proposing a rejected change again.
_Avoid_: history, decisions log

**Run**:
One out-of-band pass of hindsight over recent sessions and the current rule files.
_Avoid_: dream, job, batch
