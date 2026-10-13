import type { Edge } from "./model.ts";

import { edgeAdder } from "./model.ts";

// E(from, to, label, options): one arrow. label: what moves along it (a hook,
// a command, a table, a file). options.kind: "dash" for a rare or optional
// path, "deny" for a refusal. No coordinates: ELK routes every arrow.
export const edges: Edge[] = [];

const E = edgeAdder(edges);

// The session and the mod
E("human", "agent", "messages, corrections");
E("agent", "api", "tours, appels d'outils");
E("api", "transcripts", "écrit le JSONL", { kind: "dash" });
E("api", "register", "hooks : session.start · prompt.submit · turn.complete · command.run · ui.render");
E("register", "host", "makeHost($)");
E("host", "api", "$.store · $.model · $.process · $.ui · $.prompt");
E("register", "humantext", "cleanHumanText");
E("register", "facts", "addHumanText");
E("register", "state", "captureHuman : readState · writeState");
E("register", "gate", "afterTurn · classifyThenDebrief (+1 ms)");
E("register", "configrules", "readConfig(config)");
E("register", "notice", "noticeLine(status)");
E("register", "pane", "ui.render → drawReview · touches → decide");
E("register", "client", "config · status · review list|decide · handoff prepare · learn --detach");
E("gate", "gaterules", "gateSkip · gateSignals · gateBrief · classifierText");
E("gate", "facts", "addToolUses · markInterrupted");
E("gate", "state", "verrou de fork · factsSince · compteur du jour");
E("gate", "host", "classify(brief, 3 derniers messages)");
E("gate", "debrief", "runDebrief(brief)");
E("gate", "client", "gate log (fire-and-forget)");
E("debrief", "debriefprompt", "debriefPrompt(brief)");
E("debrief", "host", "fork(prompt) → texte, usage");
E("debrief", "client", "debrief start · debrief record (120 s)");
E("pane", "redact", "unifiedDiff · toDraft · displayText");
E("client", "main", "bun src/cli/main.ts <cmd> --json · stdin JSON · dernière ligne");

// The CLI
E("main", "configrules", "readConfig");
E("config", "main", "config.json");
E("main", "record", "debrief record");
E("main", "learn", "learn [--if-due | --detach]");
E("main", "prune", "prune [--repo]");
E("main", "port", "review list · review decide · handoff prepare");
E("main", "replay", "gate replay --days");
E("main", "statusdoctor", "status · doctor");
E("main", "queries", "gate log → gate_decisions · debrief start → debriefs");
E("record", "reader", "readSession(id) avec continuations");
E("transcripts", "reader", "*/<session>.jsonl et ses continuations");
E("reader", "humantext", "cleanHumanText · slashCommand");
E("record", "debriefprompt", "parseDebrief(texte)");
E("record", "redact", "containsVerbatim · collapseWhitespace");
E("record", "queries", "debriefs · messages · notes · proposals (Stale Rule)");
E("record", "learn", "spawn détaché : learn --if-due dès 8 Notes", { kind: "dash" });
E("replay", "reader", "scanSessionFile");
E("replay", "gaterules", "gateSkip · gateSignals · gatePasses");
E("replay", "facts", "addHumanText · addToolUses");
E("learn", "learncontract", "prompt · JSON Schema · gateLearn");
E("learn", "claudep", "claude -p, un appel par groupe, sous budget");
E("learn", "inventory", "inventory(repoRoots)");
E("learn", "queries", "learn_runs (verrou) · notes · proposals · decisions");
E("learn", "prune", "prune(repoRoots) en fin de passage");
E("learn", "humantext", "markersFor : une Steer explicite passe seule");
E("record", "rulefiles", "lit le fichier édité et la Rule File d'une Stale Rule");
E("record", "inventory", "fingerprint(ruleFile, lesson)");
E("learncontract", "proposal", "VERDICTS");
E("learncontract", "redact", "redactSecrets (prompt)");
E("prune", "inventory", "inventory(roots), puis staleScan sur ses Rule Files");
E("prune", "queries", "proposals (description) · decisions");
E("inventory", "rulefiles", "lit · git ls-files · @imports · hash-object");
E("port", "proposal", "nextProposalState");
E("port", "queries", "proposals · decisions (Ledger) · handoffs · messages");
E("port", "redact", "redactSecrets (lecture)");
E("port", "apply", "accept → applyChange(cible, éditions, sujet, Lesson, Prevalence, extraits bruts)");
E("apply", "checkout", "écrit · git add · git commit --file=- -- <chemin>");
E("apply", "rulefiles", "écriture directe d'un fichier global", { kind: "dash" });
E("statusdoctor", "queries", "abortStaleDebriefs · comptes");
E("queries", "db", "run · all · get · transaction");
E("db", "migrations", "migrate : user_version");
E("db", "paths", "dbPath · 0700 · 0600");
E("paths", "config", "configPath");

// The overview's arrows: one per pair of boxes (a root zone, or a system
// outside), each backed by at least one brick arrow between those boxes
// (check.ts). The label names what flows at that scale.
export const OVERVIEW_FLOWS: readonly Edge[] = [
  { from: "human", to: "session", label: "messages, corrections" },
  { from: "session", to: "transcripts", label: "JSONL de la session", kind: "dash" },
  { from: "session", to: "domain", label: "importe le noyau pur" },
  { from: "session", to: "cli", label: "bun main.ts <commande> · une ligne JSON" },
  { from: "config", to: "cli", label: "config.json" },
  { from: "cli", to: "domain", label: "importe le noyau pur" },
  { from: "transcripts", to: "cli", label: "relus : Quotes, outils, Loaded Rules" },
  { from: "cli", to: "claudep", label: "Learn : un appel par dépôt" },
  { from: "cli", to: "rulefiles", label: "inventaire · écriture globale" },
  { from: "cli", to: "checkout", label: "un commit d'un fichier, jamais poussé" },
];
