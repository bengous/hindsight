import type { Brick } from "./model.ts";

import { defaultConfig } from "../../src/domain/config.ts";
import { brickAdder } from "./model.ts";

// add(zone, id, label, sub, info, options)
//   zone     zone id, or null for a system outside hindsight
//   label    short name drawn on the plan
//   sub      mono subtitle, "\n" between lines
//   info     panel content, fields listed at the top of data-zones.ts
//   options  color: a --z-* token; side: for an outside system, its column
//            ("in" left, "out" right); couples: ids of bricks that must
//            change when this one is replaced, listed on one side only.
export const bricks: Brick[] = [];

const G = defaultConfig.gate;

const L = defaultConfig.learn;

const fr = (n: number): string => String(n).replace(".", ",");

const add = brickAdder(bricks);

// ---------- outside hindsight ----------
add(
  null,
  "human",
  "Vous",
  "corrections, décisions",
  {
    kicker: "SPEC.md · Actors",
    title: "Vous",
    lead: "Vous travaillez avec les agents, puis vous relisez les Proposals et décidez. Vos messages tapés ou dictés sont la seule source de Quotes ; une Décision de votre main précède chaque écriture.",
    io: [
      [
        "Donne",
        "vos messages dans la session, vos pressions dans le panneau de Review, le prompt de Handoff que vous envoyez",
      ],
      ["Reçoit", "la ligne de statut, les toasts, le panneau ; jamais un texte dans le contexte de l'agent"],
    ],
    see: ["register", "pane"],
  },
  { color: "--z-human", side: "in", couples: [] },
);

add(
  null,
  "transcripts",
  "Transcripts",
  "~/.claude/projects/*/<session>.jsonl",
  {
    kicker: "src/transcripts/",
    title: "Les transcripts",
    lead: "Les fichiers JSONL que Claude Code écrit pour chaque session, avec leurs continuations. Le CLI y relit vos messages, les appels d'outils et les Rule Files chargées pour vérifier chaque Note, et <code>gate replay</code> y rejoue le code du Portail.",
    io: [
      ["Écrit par", "le moteur Claude Code, à chaque échange"],
      ["Lu par", "debrief record (vérification), gate replay (calibrage)"],
    ],
    swap: "Changer d'agent (un autre harnais) revient à réécrire <code>src/transcripts/</code> : la lecture d'une session, ses continuations, l'origine d'un message.",
    facts: [["Scratch", "HINDSIGHT_PROJECTS_DIR pointe ailleurs pour les tests"]],
    see: ["record", "replay"],
  },
  { color: "--z-ext", side: "in", couples: ["record", "replay"] },
);

add(
  null,
  "config",
  "config.json",
  "$XDG_CONFIG_HOME/hindsight",
  {
    kicker: "src/domain/config.ts · src/store/paths.ts",
    title: "La configuration",
    lead: "Chaque champ est optionnel et posé sur les défauts du domaine : seuil, refroidissement, plafond quotidien, plancher de cache, modèle du classifieur, seuils et budget de Learn, fenêtre des Notes, taille d'une passe de Review, dépôts exclus. <code>hindsight config</code> imprime les valeurs effectives.",
    io: [
      ["Lu par", "le mod à session.start, chaque commande du CLI"],
      ["Défauts", "src/domain/config.ts"],
    ],
    facts: [
      [
        "Portail",
        `threshold ${fr(G.threshold)} · cooldownMs ${G.cooldownMs} × min(n, ${G.cooldownMaxSteps}) · quietMinTools ${G.quietMinTools} · dailyCap ${G.dailyCap} · minCacheShare ${fr(G.minCacheShare)}`,
      ],
      [
        "Learn",
        `pendingNotes ${L.pendingNotes} · minIntervalMs ${L.minIntervalMs / 3_600_000} h · model ${L.model} · maxBudgetUsd ${L.maxBudgetUsd} · timeoutMs ${L.timeoutMs / 60_000} min`,
      ],
      ["Notes, Review", `windowDays ${defaultConfig.notes.windowDays} · pageSize ${defaultConfig.review.pageSize}`],
    ],
    see: ["configrules"],
  },
  { color: "--z-ext", side: "in", couples: ["configrules"] },
);

add(
  null,
  "claudep",
  "claude -p",
  "Opus · --json-schema · sans repli",
  {
    kicker: "src/learn/claude.ts",
    title: "claude -p, pour Learn",
    lead: "Le seul modèle que le CLI appelle : un processus <code>claude --print</code> sans outil, avec le JSON Schema dérivé de Learn et un budget par passage, <code>CLAUDECODE</code> retiré de l'environnement. Opus, sans repli : un <code>claude</code> absent ou un échec ferme le passage en erreur.",
    io: [
      ["Reçoit", "le prompt de Learn pour un dépôt, le schéma, le budget"],
      ["Produit", "une réponse JSON que le même Schema décode"],
    ],
    why: [
      "Un modèle plus faible qui propose des règles vaut moins qu'aucune proposition : les Notes attendent le passage suivant (ADR 0005).",
    ],
    see: ["learn"],
  },
  { color: "--z-model", side: "out", couples: ["learn"] },
);

add(
  null,
  "rulefiles",
  "Rule Files",
  "AGENTS.md · CLAUDE.md · .claude/rules · styles",
  {
    kicker: "src/rules/inventory.ts",
    title: "Les Rule Files",
    lead: "Ce que vos agents chargent : les fichiers globaux là où les agents les lisent, et ceux de chaque checkout git présent sur la machine. hindsight les lit pour Learn et Prune, et n'y écrit qu'après une Décision : un commit du seul fichier dans son dépôt, ou une écriture directe pour un fichier global hors dépôt.",
    io: [
      ["Lu par", "Learn (règles courantes), Prune (globs, chemins, scripts), la vérification des Stale Rules"],
      ["Écrit par", "applyChange, après accept ; jamais poussé"],
    ],
    see: ["inventory", "apply"],
  },
  { color: "--z-rules", side: "out", couples: [] },
);

add(
  null,
  "checkout",
  "Dépôt git",
  "un commit, jamais poussé",
  {
    kicker: "src/platform/git.ts",
    title: "Le dépôt cible",
    lead: "Le checkout qui porte la Rule File d'une Proposal acceptée. Git y tourne avec les variables <code>GIT_*</code> du dépôt courant retirées, donc les hooks du dépôt cible s'exécutent et peuvent refuser le commit : le fichier est alors restauré et la Proposal libérée.",
    io: [
      ["Reçoit", "un commit d'un seul fichier, message sans Quote"],
      ["Produit", "le sha que le Ledger garde"],
    ],
    see: ["apply"],
  },
  { color: "--z-rules", side: "out", couples: ["apply"] },
);

// ---------- the shared domain ----------
const DOMAIN = { color: "--z-domain" } as const;

add(
  "domain",
  "facts",
  "facts.ts",
  "TurnFacts · ToolUse",
  {
    kicker: "src/domain/facts.ts",
    title: "Les faits d'un tour",
    lead: "Ce qui s'est passé dans une session depuis son dernier Debrief, accumulé tour par tour : les textes humains avec leurs marqueurs, les chemins édités, les appels et erreurs d'outil, les outils refusés, les commits, le suivi d'une interruption.",
    io: [
      ["Reçoit", "un texte humain nettoyé, les ToolUse d'un tour"],
      ["Produit", "un TurnFacts immuable, 20 textes au plus, 4 000 caractères chacun"],
    ],
    facts: [
      ["Rule File", String.raw`(AGENTS|CLAUDE)\.md · .claude/rules/*.md · output-styles/*.md`],
      ["Commit", String.raw`git (-x …)* commit`],
    ],
  },
  { ...DOMAIN, couples: ["gaterules", "humantext"] },
);

add(
  "domain",
  "gaterules",
  "gate.ts",
  "sauts · signaux · brief",
  {
    kicker: "src/domain/gate.ts",
    title: "Les règles du Portail",
    lead: "Les sauts directs dans leur ordre, les sept signaux et leurs poids, le seuil, le brief que reçoivent le classifieur puis le Debrief, et le texte complet du classifieur. Le même code tourne dans le mod à chaque tour, dans <code>gate replay</code> sur les transcripts passés, et dans l'onglet Produit de cette page.",
    io: [
      ["Reçoit", "un GateState (session, verrou, compteurs, horloge), un TurnFacts, la configuration"],
      ["Produit", "une raison de saut ou null, des signaux et un score, un brief"],
    ],
    facts: [
      [
        "Sauts",
        "non-interactive · subagent · turn-aborted · fork-running · repo-excluded · daily-cap · cooldown · quiet",
      ],
      ["Poids 1", "human_marker · tool_refused · after_interrupt · rule_file_edit"],
      ["Poids 0,5", "many_edits (≥ 3) · tool_errors (≥ 2) · git_commit"],
    ],
    why: [
      "Le rejeu sur vos transcripts calibre le seuil : un signal fort seul, ou deux faibles, atteignent le classifieur (ADR 0005). La valeur courante est dans src/domain/config.ts, chaque réglage dans plans/.",
    ],
  },
  { ...DOMAIN, couples: ["gate", "replay"] },
);

add(
  "domain",
  "humantext",
  "human.ts",
  "cleanHumanText · markersFor",
  {
    kicker: "src/domain/human.ts",
    title: "Le texte humain",
    lead: "Ce qui fait d'un texte un message humain, et ce qu'il dit. Le nettoyage retire les rappels système et les collages étrangers, et ne garde d'un collage que votre propre dictée. Les marqueurs repèrent une correction forte ou moyenne, une consigne durable, la frustration, un message après interruption ou après refus.",
    io: [
      ["Reçoit", "le texte brut de prompt.submit, le contexte (premier message, interruption, outils refusés)"],
      ["Produit", "un texte nettoyé, une liste ordonnée de marqueurs"],
    ],
    facts: [
      [
        "Dictée gardée",
        "≥ 150 caractères, première personne en français, sans markdown, chemin, URL ni glyphe de terminal",
      ],
      ["Correction moyenne", "jamais sur le premier message, et dans les 400 premiers caractères"],
    ],
  },
  { ...DOMAIN, couples: ["register"] },
);

add(
  "domain",
  "debriefprompt",
  "debrief.ts",
  "les cinq questions · parseDebrief",
  {
    kicker: "src/domain/debrief.ts",
    title: "Le prompt du Debrief et son lecteur",
    lead: "Le message ajouté au fork : les cinq questions, les exclusions, les règles de preuve (une Quote copiée mot pour mot, un extrait contigu d'au moins 12 caractères, une Stale Rule avec le texte courant de la règle) et le bloc JSON attendu. Le lecteur rend des Notes ou une raison d'échec, jamais une exception.",
    io: [
      ["Reçoit", "le brief du Portail ; puis le texte du fork"],
      ["Produit", "le prompt ; puis steers, observations, staleRules, 12 par liste au plus"],
    ],
    facts: [["Version", "DEBRIEF_PROMPT_VERSION 1 : déclarée, jamais lue ni stockée"]],
    warn: "Une question 5 sans seuil de faiblesse : chaque correction est une Steer, habitude ou cas unique. Les deux premiers forks mesurés rendaient des listes vides avant cette exemption.",
  },
  { ...DOMAIN, couples: ["debrief", "record"] },
);

add(
  "domain",
  "proposal",
  "proposal.ts",
  "états · Verdicts",
  {
    kicker: "src/domain/proposal.ts",
    title: "Les états d'une Proposal",
    lead: "Six états et une règle : seule une Proposal en attente bouge. accept, handoff, reject, supersede et expire mènent chacun à un état terminal. Les six Verdicts de Learn vivent ici aussi.",
    io: [
      ["Reçoit", "un état et un événement"],
      ["Produit", "l'état suivant, ou null quand l'événement ne s'applique pas"],
    ],
    see: ["port", "pane"],
  },
  { ...DOMAIN, couples: ["port", "pane"] },
);

add(
  "domain",
  "configrules",
  "config.ts",
  "défauts · readConfig",
  {
    kicker: "src/domain/config.ts",
    title: "La configuration par défaut",
    lead: "Les valeurs effectives de hindsight et la lecture de <code>config.json</code> par-dessus : un champ absent ou illisible garde son défaut, jamais une erreur.",
    io: [
      ["Reçoit", "le JSON de config.json, ou rien"],
      ["Produit", "un HindsightConfig complet"],
    ],
  },
  { ...DOMAIN, couples: [] },
);

add(
  "domain",
  "redact",
  "redact.ts · diff.ts · text.ts",
  "secrets · diff unifié · verbatim",
  {
    kicker: "src/domain/redact.ts · diff.ts · text.ts",
    title: "Masquage, diff et texte",
    lead: "Le masquage des secrets (clés, jetons, mots de passe affectés) avant tout affichage ou envoi à un modèle ; le diff unifié qu'affiche le panneau, et le marqueur ⏎ de son Input d'une ligne ; la recherche mot pour mot qui ne tolère que les blancs, la normalisation d'une Lesson, le texte sûr pour un terminal.",
    io: [
      ["Reçoit", "un texte ; un chemin et des éditions ; une citation et un message"],
      ["Produit", "le texte masqué ; un diff ; vrai quand la citation est dans le message"],
    ],
  },
  { ...DOMAIN, couples: ["pane", "record"] },
);
