import type { Flow } from "./model.ts";

import { defaultConfig } from "../../src/domain/config.ts";

const G = defaultConfig.gate;

const L = defaultConfig.learn;

const fr = (n: number): string => String(n).replace(".", ",");

export const FLOW: Flow = {
  nodes: [
    {
      id: "session",
      label: "Session de travail",
      sub: "vous corrigez l'agent",
      by: "human",
      info: "Une session principale et interactive de Claude Code. L'agent fait sa tâche ; hindsight n'y ajoute rien : pas de contexte, pas de texte dans les réponses de commande. Le mod capte votre texte à <code>prompt.submit</code> (origines <code>composer</code> et <code>bridge</code>) et le nettoie des rappels système et des collages étrangers.",
    },
    {
      id: "facts",
      label: "TurnFacts",
      sub: "turn.complete",
      by: "code",
      info: "Le mod relève les outils du tour (éditions, erreurs, refus, commits) et les ajoute aux faits de la session depuis son dernier Debrief, dans <code>$.store</code> sous <code>session:&lt;id&gt;</code>.",
    },
    {
      id: "gate",
      label: "Portail : code",
      sub: "sauts, signaux, seuil",
      by: "code",
      info: "Sauts directs d'abord (non interactif, sous-agent, tour interrompu, fork en cours, dépôt exclu, plafond quotidien, refroidissement, tour calme), puis les signaux pesés contre le seuil. Chaque décision part au journal <code>gate_decisions</code>.",
    },
    {
      id: "classify",
      label: "Classifieur",
      sub: "$.model.classify",
      by: "model",
      info: "Seulement quand le code dit oui : un petit modèle lit le brief du code et vos trois derniers messages, répond <code>debrief</code> ou <code>skip</code>. Il tourne depuis un minuteur, jamais dans le hook du tour.",
    },
    {
      id: "nothing",
      label: "rien ne se passe",
      sub: "",
      by: "code",
      info: "Aucun fork, aucun coût, rien dans la session. C'est le cas de la grande majorité des tours.",
    },
    {
      id: "fork",
      label: "Debrief",
      sub: "$.model.fork sur le cache",
      by: "model",
      info: "La dernière requête du fil principal, rejouée avec le prompt des cinq questions ajouté et tous les outils refusés. Le préfixe est servi par le cache de la session ; la part lue est mesurée sur l'usage du fork.",
    },
    {
      id: "record",
      label: "debrief record",
      sub: "le CLI vérifie chaque Note",
      by: "code",
      info: "Le CLI relit le transcript : une Quote doit figurer mot pour mot dans un de vos messages (le plus ancien est cité), une Observation doit correspondre à un appel d'outil réel, une Stale Rule à une édition réelle que le fichier porte encore. Ce qui échoue est compté sur la ligne du Debrief, jamais stocké.",
    },
    {
      id: "notes",
      label: "Notes en attente",
      sub: "Steers, Observations",
      by: "code",
      info: `Une Note attend que Learn l'utilise, ${defaultConfig.notes.windowDays} jours au plus. Une Stale Rule confirmée par le code devient tout de suite une Proposal.`,
    },
    {
      id: "learn",
      label: "Learn",
      sub: "Opus, un appel par dépôt",
      by: "model",
      info: `Détaché par <code>debrief record</code> quand ${L.pendingNotes} Notes attendent et ${L.minIntervalMs / 3_600_000} h ont passé. Le modèle regroupe par Lesson, rédige et choisit une cible ; le code compte la Prevalence, valide la cible et filtre par le Ledger.`,
    },
    {
      id: "prune",
      label: "Prune",
      sub: "globs, chemins, scripts",
      by: "code",
      info: "Sans modèle, dans le même passage que Learn : motifs <code>paths:</code> sans fichier, chemins cités disparus, scripts absents. Produit des Proposals en description.",
    },
    {
      id: "proposals",
      label: "Proposals",
      sub: "triées par Prevalence",
      by: "code",
      info: "Cible, changement (modification exacte ou description), preuves, Prevalence, Verdict, raisonnement en français, Lesson en anglais.",
    },
    {
      id: "review",
      label: "Review",
      sub: "le panneau, vous décidez",
      by: "human",
      info: "<code>/hindsight review</code> ouvre le panneau : une Proposal par écran, une passe de review.pageSize. Accepter, Modifier, Rejeter avec une raison, Handoff. Chaque Décision va au Ledger.",
    },
    {
      id: "commit",
      label: "Commit",
      sub: "un fichier, jamais poussé",
      by: "code",
      info: "Un accept réserve la Proposal, applique la modification exacte (une seule occurrence) et commit le seul fichier, hooks du dépôt actifs. Le message porte le sujet, la Lesson et les comptes de preuves, jamais une Quote.",
    },
    {
      id: "handoff",
      label: "Handoff",
      sub: "vous lancez la session",
      by: "human",
      info: "Pour ce qu'une modification de texte ne fait pas : un hook, une restructuration. <code>/hindsight handoff</code> remplit le prompt avec les instructions, sans Quote ; c'est vous qui envoyez.",
    },
  ],
  edges: [
    { id: "e-turn", from: "session", to: "facts", label: "fin du tour" },
    { id: "e-gate", from: "facts", to: "gate", label: "" },
    { id: "e-brief", from: "gate", to: "classify", label: "score ≥ seuil, brief" },
    { id: "e-skip", from: "gate", to: "nothing", label: "saut ou sous le seuil" },
    { id: "e-cskip", from: "classify", to: "nothing", label: "skip" },
    { id: "e-fork", from: "classify", to: "fork", label: "debrief" },
    { id: "e-record", from: "fork", to: "record", label: "texte, part de cache" },
    { id: "e-notes", from: "record", to: "notes", label: "Notes retenues" },
    { id: "e-learn", from: "notes", to: "learn", label: `${L.pendingNotes} Notes, ${L.minIntervalMs / 3_600_000} h` },
    { id: "e-prune", from: "notes", to: "prune", label: "même passage", kind: "dash" },
    { id: "e-pl", from: "learn", to: "proposals", label: "" },
    { id: "e-pp", from: "prune", to: "proposals", label: "" },
    { id: "e-notice", from: "proposals", to: "review", label: "Notice au démarrage" },
    { id: "e-accept", from: "review", to: "commit", label: "accept" },
    { id: "e-handoff", from: "review", to: "handoff", label: "handoff", kind: "dash" },
  ],
  steps: [
    {
      nodes: ["session"],
      edges: [],
      text: "<strong>Vous corrigez l'agent</strong> : « non, pas de npm pour ça, c'est un dépôt pnpm ». L'agent applique la correction. Il ne sait pas que hindsight existe.",
    },
    {
      nodes: ["facts"],
      edges: ["e-turn"],
      text: "Le tour se termine. Le mod a déjà capté votre message à <strong>prompt.submit</strong> ; il relève maintenant les outils du tour : un <code>npm install</code> refusé, une édition. Tout s'ajoute aux <strong>TurnFacts</strong> de la session.",
    },
    {
      nodes: ["gate"],
      edges: ["e-gate"],
      text: `<strong>Le code décide</strong> : aucun saut direct ne s'applique. Signaux : correction dans un message humain (1) et outil refusé (1). Score 2, au-dessus du seuil ${fr(G.threshold)}. La décision est journalisée.`,
    },
    {
      nodes: ["classify"],
      edges: ["e-brief"],
      text: "Depuis un minuteur, hors du hook, <strong>le classifieur</strong> lit le brief du code et vos derniers messages. Il répond <code>debrief</code>.",
    },
    {
      nodes: ["fork"],
      edges: ["e-fork"],
      text: "<strong>Le Debrief</strong> forke la session sur son propre cache et répond aux cinq questions en texte. Question 5 : une habitude, avec votre phrase citée mot pour mot.",
    },
    {
      nodes: ["record"],
      edges: ["e-record"],
      text: "<strong>debrief record</strong> retrouve la citation dans votre message du transcript, fabrique l'id de preuve, stocke le message entier. Une Observation dont l'extrait avait été raccourci est rejetée et comptée.",
    },
    {
      nodes: ["notes"],
      edges: ["e-notes"],
      text: "Une <strong>Steer</strong> attend, avec sa Lesson : <em>Install packages with pnpm.</em> Deux autres sessions, d'autres jours, apportent la même leçon.",
    },
    {
      nodes: ["learn", "prune"],
      edges: ["e-learn", "e-prune"],
      text: `${L.pendingNotes} Notes attendent : <strong>Learn</strong> part hors bande, un appel Opus pour ce dépôt. Le code compte la Prevalence (3 sessions, 3 jours) et accepte le candidat ; <strong>Prune</strong> vérifie les Rule Files dans le même passage.`,
    },
    {
      nodes: ["proposals"],
      edges: ["e-pl", "e-pp"],
      text: "Une <strong>Proposal</strong> : l'AGENTS.md du dépôt, une ligne ajoutée, les trois citations, Verdict <code>missing</code>.",
    },
    {
      nodes: ["review"],
      edges: ["e-notice"],
      text: "À votre session suivante, une ligne de statut : <strong>1 Proposal en attente · /hindsight review</strong>. Le panneau montre le diff et les citations. Vous pressez Accepter.",
    },
    {
      nodes: ["commit"],
      edges: ["e-accept"],
      text: "<strong>Un commit</strong> d'AGENTS.md seul, jamais poussé, sans citation dans le message. La Décision va au Ledger : un rejet ne reviendrait qu'avec plus de sessions.",
    },
  ],
};

export const GUARDS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "Rien dans le contexte de l'agent",
    "Les commandes <code>/hindsight</code> répondent <code>{}</code>, <code>turn.complete</code> rend ce qu'il a reçu, aucun <code>additionalContext</code>. Vous voyez la ligne de statut, les toasts et le panneau ; seul <code>/hindsight handoff</code> remplit le prompt, et c'est vous qui envoyez.",
    "src/mod/register.ts",
  ],
  [
    "Vos mots seulement",
    "Une Quote doit figurer mot pour mot dans un de vos messages, avant masquage ; sortie d'outil, collage étranger, message d'un autre agent ne comptent jamais. Le code fabrique les ids de preuve, le fork n'en invente aucun.",
    "src/domain/human.ts · src/debrief/record.ts",
  ],
  [
    "Le cache, ou l'erreur",
    "La part de cache de chaque fork est mesurée sur son usage et stockée ; sous le plancher, le Debrief est en erreur et aucune Note n'est gardée, seul le texte brut reste sur sa ligne. Learn tourne sur Opus sans modèle de repli.",
    "src/mod/debrief.ts · src/learn/claude.ts",
  ],
  [
    "Une Décision humaine avant tout écrit",
    "Un accept réserve la Proposal, applique une modification qui doit correspondre une seule fois, commit un seul fichier, jamais poussé. Un hook qui refuse restaure le fichier. Un rejet porte une raison et nourrit le Ledger.",
    "src/review/port.ts · src/rules/apply.ts",
  ],
  [
    "Pas de Quote hors de la base",
    "Le message de commit est contrôlé contre les preuves brutes ; le Handoff est écrit sans Quote ; l'état vit dans <code>$XDG_STATE_HOME/hindsight</code> en 0700, base en 0600.",
    "src/rules/apply.ts · src/store/paths.ts",
  ],
  [
    "La récurrence pèse, le code compte",
    "La Prevalence est calculée par le code, jamais par le modèle. Une seule session suffit quand la consigne est énoncée, contredit une règle chargée, ou qu'une Observation est claire. Pour Learn, une empreinte rejetée ne revient qu'avec plus de sessions ; Prune et les Stale Rules la bloquent pour toujours.",
    "src/learn/gates.ts",
  ],
  [
    "Le domaine reste pur",
    "<code>src/domain/</code> n'importe ni Node, ni Bun, ni Effect : le mod n'a pas de Node, et cette page fait tourner le même code dans votre navigateur.",
    "src/domain/*.ts",
  ],
];
