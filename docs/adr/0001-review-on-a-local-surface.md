# Review proposals on a local surface, not in pull requests

Each proposal is reviewed on a surface drawn on the human's machine, behind one output port of the CLI (`review list`, `review decide`, `handoff prepare`): a pane inside the Claude Code session first, a page served on the loopback interface when one is wanted. It is never a GitHub pull request or a branch of commits. A proposal's evidence is quotes from the human's transcripts, which must never leave the machine, and a rejection must carry a reason that the ledger keeps; a pull request would publish the quotes and a branch would lose the reasons.

## Considered Options

- A pull request per proposal: publishes the quotes, loses the rejection reasons.
- A page alone, as the prototype served it: one more process to start and a browser to open for a decision that takes ten seconds; the pane keeps the human where the correction happened, and the port keeps the page possible.
