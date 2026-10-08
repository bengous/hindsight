# A cache-sharing fork per session, then out-of-band consolidation

When a session ends and is worth it, hindsight forks it: the fork reads the whole session from the parent's prompt cache and reports what it learned, what blocked it and which rules look stale, as notes stored by hindsight. Cross-session consolidation then runs out of band over the accumulated notes and alone produces proposals, because only it sees what recurs. The fork must keep the parent's model, tools and system prompt and only append a final message, since any change to that prefix rebuilds the cache at full price; a measured `--tools ""` fork read none of the parent's cache, which is the cost that sank the sibling tool's forks.

## Considered Options

- A fork that proposes rules directly, as the sibling tool's fork reported: it sees one session, so it cannot weigh recurrence.
- A batch extraction over transcript digests, as in the prototype: no shared cache and little context per human message.
