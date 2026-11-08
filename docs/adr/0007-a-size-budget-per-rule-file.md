# A Size Budget per Rule File, held by Learn's gate and flagged by Prune

Every Rule File hindsight edits stays under one Size Budget, 10,000 characters by default (`rules.sizeBudgetChars`), counted the way Claude Code counts an instruction file: the length of its text, file by file. What an agent loads has to stay short: Claude Code's memory guide says longer instruction files consume more context and reduce adherence, and Anthropic's "The components of agent memory" keeps the injected top layer of memory small by moving detail down to what loads on demand. Learn's gate drops an edit whose result is longer than the larger of the budget and the file's current length, counted as `over-budget`: a file with room grows up to the budget, a file at or past it takes only an edit that does not lengthen it (a replacement, a merge, the rewrite of a wrong Rule), and a new file must fit. The prompt gives Learn each Rule File's length and the budget, so the model proposes the replacement, the merge or the path-scoped target itself; the gate enforces, as it does for the global scope. Prune's code checks gain one: a Rule File over the budget, global ones included, becomes a description for a Handoff that trims it or moves its detail into path-scoped files. Its fingerprint holds the file and the budget, not the measured length, so a rejection holds until the budget changes.

Measured over the human's checkouts and global files, 10,000 characters left every Rule File with pending Proposals under the budget and put eight of the files agents load over it, one of them loaded at session start. Each set of files a session loads at start held one or two files. Lines hid density: the files ran from about 30 to 450 bytes a line, and a 40-line file held over 15,000 characters. Learn's prompt shows each file up to 12,000 characters, so every file under the budget reaches the model whole.

The budget binds what hindsight proposes, not what the human decides: `review decide` applies an edit the human wrote past it. Each Proposal is measured against the file as Learn read it, so two pending Proposals accepted together can cross the budget; the next run then refuses growth, and Prune proposes the trim. Learn's cost per run (`maxBudgetUsd`) is a separate budget.

## Considered Options

- Lines, the unit of Claude Code's guidance (200 per file): lines hide density, so a dense file escapes the budget.
- A budget per set of files loaded at session start, summed per scope: closer to the injected layer, but every set measured held one or two files, and Prune would have to pick which file of a set to trim.
- 8,000 characters: two files Learn targets were already full, and nineteen files were over.
- An over-budget edit turned into a Handoff by the code: every full file would yield one Handoff per Rule, while the model can already propose a description that restructures a file.
- A soft budget shown in the Review: the file still grows, and the human sees the overflow only once Learn has spent its call.
- The size shown in the Review instead of a Prune Proposal: a file over the budget with no pending edit would never be flagged, and Learn would stop growing it without a word.
