# A cache-sharing fork of the session, then out-of-band consolidation

When a turn ends and the Debrief Gate judges it worth it, hindsight forks the session. The fork inherits the whole session as its own context, served from the parent's prompt cache, so it reads nothing again: it only answers the debrief questions about the turns since its previous debrief, and hindsight stores the answers as notes. Learn then runs out of band over the accumulated notes and turns steers and observations into proposals, because only it sees what recurs; a suspected stale rule whose edit the code confirms goes to Prune and becomes a proposal at once. The fork must keep the parent's model, tools and system prompt and only append a final message, since any change to that prefix rebuilds the cache at full price; a measured `--tools ""` fork read none of the parent's cache, which is the cost that sank the sibling tool's forks. ADR 0004 records how the fork runs.

## Considered Options

- A fork that proposes rules directly, as the sibling tool's fork reported: it sees one session, so it cannot weigh recurrence.
- A batch extraction over transcript digests, as in the prototype: no shared cache and little context per human message.
