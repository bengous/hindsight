import type { Brick } from "./model.ts";

import { brickAdder } from "./model.ts";

export const bricksMod: Brick[] = [];

const add = brickAdder(bricksMod);

// ---------- the session: the engine's side ----------
const SESSION = { color: "--z-session" } as const;

add(
  "session",
  "agent",
  "L'agent de travail",
  "fil principal · ses outils · son cache",
  {
    kicker: "SPEC.md · Actors",
    title: "L'agent de travail",
    lead: "Le modèle qui fait votre tâche, avec ses outils et le cache de prompt que la session construit. hindsight ne lui ajoute rien : ses hooks rendent ce qu'ils ont reçu, ses commandes répondent <code>{}</code>. Seul le fork du Debrief réutilise son cache, et le fork ne peut lancer aucun outil.",
    io: [
      ["Reçoit", "vos messages, les résultats d'outils"],
      ["Produit", "les tours que turn.complete annonce, le transcript JSONL que le moteur écrit"],
    ],
    see: ["api", "transcripts"],
  },
  { ...SESSION, couples: [] },
);

add(
  "session",
  "api",
  "L'API du mod : $",
  "hooks · model · store · ui · process · prompt",
  {
    kicker: "types/claude-code.d.ts (écrit par Claude Code 2.1.296)",
    title: "L'API du mod",
    lead: "Ce que le moteur offre à un mod : des hooks de fonction (<code>session.start</code>, <code>prompt.submit</code>, <code>turn.complete</code>, <code>command.run</code>, <code>ui.render</code>), deux appels modèle (<code>$.model.classify</code>, <code>$.model.fork</code>), un store JSON, l'interface (statut, toast, panneau), un lanceur de processus, le remplissage du prompt.",
    io: [
      ["Reçoit", "les hooks enregistrés par register.ts, les appels du Host"],
      ["Produit", "les événements de la session, le fork servi par le cache avec son usage, le texte du classifieur"],
    ],
    swap: "Les types viennent de <code>types/claude-code.d.ts</code>, régénéré depuis un chargement <code>--plugin-dir</code> (<code>.claude-plugin/types/</code>), jamais édité. Une nouvelle version du moteur se lit là, puis dans <code>host.ts</code> et <code>register.ts</code>.",
    facts: [
      ["Budget", "10 s par hook ; le temps dans $.process.run n'est pas compté"],
      [
        "Fork",
        "la dernière requête du fil principal, même modèle, même système, mêmes outils tous refusés, le prompt ajouté",
      ],
      ["Mesure", "usage.cache_read_input_tokens du fork dit quelle part du préfixe venait du cache"],
      [
        "$.store",
        "un fichier JSON du plugin sous le dossier de configuration de Claude Code : le compteur day:<jour> est partagé entre projets",
      ],
    ],
    see: ["register", "host"],
  },
  { ...SESSION, couples: ["register", "host"] },
);

// ---------- the mod ----------
const MOD = { color: "--z-mod" } as const;

add(
  "mod",
  "register",
  "register.ts",
  "hooks · /hindsight · makeHost",
  {
    kicker: "src/mod/register.ts",
    title: "register.ts",
    lead: "Le seul fichier qui touche <code>$</code>. Il enregistre les hooks, construit le Host, sert les cinq sous-commandes de <code>/hindsight</code> et porte les actions du panneau. Aucune logique n'y vit : chaque hook délègue.",
    io: [
      [
        "Reçoit",
        "session.start (isInteractive, config, Notice, nettoyage du store), prompt.submit (origines composer et bridge seulement), turn.complete (fil principal seulement), command.run, ui.render",
      ],
      [
        "Produit",
        "{} pour les commandes, le résultat de next(e) pour le tour ; des toasts, la ligne de statut, le panneau, le prompt du Handoff",
      ],
    ],
    swap: "Un autre moteur de hooks remplace ce fichier et <code>host.ts</code> ; le reste du mod lit un Host et ne change pas.",
    facts: [
      ["Commandes", "review · status · debrief · learn · handoff (status par défaut)"],
      [
        "État du panneau",
        "la valeur $.state hindsight.review, déclarée dans types/index.d.ts ; une écriture redessine",
      ],
      [
        "Variables de module",
        "config, isInteractive, drafts (le texte en cours de saisie) : perdues à un rechargement",
      ],
      ["Timer", "turn.complete programme endTurn à +1 ms : Portail, classifieur et fork tournent hors du hook"],
    ],
    warn: "<code>/hindsight debrief</code> ignore sauts et classifieur : seul le verrou de fork s'applique. Un tour de sous-agent est filtré avant le Portail et n'est jamais journalisé.",
    see: ["host", "gate", "pane"],
  },
  { ...MOD, couples: ["host", "api", "humantext", "facts", "client", "pane"] },
);

add(
  "mod",
  "host",
  "host.ts",
  "Host : now · store · run · classify · fork · ui",
  {
    kicker: "src/mod/host.ts · makeHost dans register.ts",
    title: "Le Host",
    lead: "L'interface que le mod lit à la place de <code>$</code> : horloge et minuteur, identifiant et dépôt de la session, ses messages, le store, l'état du panneau (lecture et mise à jour de l'atom hindsight.review), le lanceur de processus, classify, fork, statut, toast, journal de debug, remplissage du prompt. Un faux Host suffit aux specs <code>bun test</code>.",
    io: [
      ["Reçoit", "les appels de gate.ts, debrief.ts, cli-client.ts, notice.ts"],
      ["Produit", "les appels $ correspondants, un pour un"],
    ],
    swap: "Ajouter une méthode touche trois fichiers ensemble : <code>host.ts</code>, <code>makeHost</code> dans register.ts, et le faux Host de <code>mod.spec.ts</code>.",
    facts: [
      [
        "Hors Host",
        "$.command.register, $.ui.open, $.ui.resolve et la lecture de l'atom dans ui.render, dans register.ts seulement",
      ],
    ],
  },
  { ...MOD, couples: ["api"] },
);

add(
  "mod",
  "state",
  "state.ts",
  "session:<id> · day:<jour> · verrou FORK_STALE_MS",
  {
    kicker: "src/mod/state.ts",
    title: "L'état de session",
    lead: "Ce que le mod garde dans <code>$.store</code> : par session, les TurnFacts depuis le dernier Debrief, l'heure de fin du dernier, leur nombre, le verrou de fork et son heure ; par jour UTC, le compte des Debriefs. Un verrou plus vieux que FORK_STALE_MS se lit comme libre.",
    io: [
      ["Reçoit", "readState, writeState, setFork, factsSince, countDebriefToday"],
      ["Produit", "un SessionState, le compte du jour"],
    ],
    facts: [
      ["FORK_STALE_MS", "src/mod/state.ts ; le même délai que ABORT_AFTER_MS côté CLI"],
      ["Nettoyage", "au démarrage : session:* inactives depuis 7 jours, day:* de plus de 2 jours"],
      [
        "Reset",
        "après un Debrief recorded ou failed : facts = factsSince(instantané) ; rien après un fork abandonné ou une exception",
      ],
    ],
    warn: "factsSince coupe par longueur de tableau : à vingt textes humains gardés, un message tapé pendant le fork est perdu (vérifié par script). Un lecture-modification-écriture concurrent entre la fin d'un tour et la fin du fork n'est pas exclu.",
    see: ["gate", "facts"],
  },
  { ...MOD, couples: ["gate", "facts"] },
);

add(
  "mod",
  "gate",
  "gate.ts",
  "afterTurn · classifyThenDebrief",
  {
    kicker: "src/mod/gate.ts",
    title: "Le Portail dans le mod",
    lead: "<code>afterTurn</code> relève les outils du dernier tour, écrit l'état, applique les sauts et le score, et journalise chaque refus. <code>classifyThenDebrief</code> tourne depuis le minuteur : verrou de fork, classifieur, journal <code>debrief</code>, puis le Debrief, puis la remise à jour de l'état et le toast.",
    io: [
      ["Reçoit", "le tour (turnId, isAborted), les messages de la session, l'état, la configuration"],
      ["Produit", "une ligne de journal par décision (gate log), un fork ou rien, un toast"],
    ],
    facts: [
      ["Journal", "skip:<raison> · below-threshold · fork-running · classifier-error|skip|unsure · debrief · forced"],
      ["Refus d'outil", "isError et texte « user rejected », « permission denied by the user »…"],
      ["Classifieur", "labels debrief|skip, petit modèle du moteur sauf gate.classifierModel"],
    ],
    warn: "Après un skip du classifieur, les faits ne sont pas remis à zéro : chaque tour suivant repasse le code et rappelle le classifieur jusqu'à un Debrief ou le plafond du jour. Les signaux sont perdus dans les lignes de journal prises à l'étape modèle.",
    see: ["gaterules", "state", "debrief"],
  },
  { ...MOD, couples: ["gaterules", "state", "debrief", "replay"] },
);

add(
  "mod",
  "debrief",
  "debrief.ts",
  "runDebrief · cacheShareOf · toast",
  {
    kicker: "src/mod/debrief.ts",
    title: "Le Debrief dans le mod",
    lead: "Ouvre la ligne (<code>debrief start</code>), lance <code>$.model.fork</code> avec le prompt des cinq questions, mesure la durée et la part de cache sur l'usage du fork, puis remet le texte au CLI (<code>debrief record</code>, 120 s). Le CLI juge le plancher et vérifie les Notes ; le mod ne lit jamais la réponse.",
    io: [
      ["Reçoit", "le brief du Portail, l'identifiant et le dépôt de la session"],
      [
        "Produit",
        "recorded, failed ou aborted ; le toast « Debrief : N Note(s) retenue(s)… » ou « Debrief en erreur »",
      ],
    ],
    facts: [
      ["Part de cache", "cache_read / (cache_read + input + cache_creation)"],
      [
        "Mesure",
        "hindsight status : part de cache minimale et moyenne des Debriefs enregistrés, durée sur chaque ligne debriefs",
      ],
    ],
    warn: "Un fork sans réponse (api-error, empty-reply, aborted, nothing-to-fork) est enregistré avec une part de cache 0 : la ligne finit <code>failed</code> avec <code>cache:0.00</code>, la vraie cause ne vit que dans le texte stocké, et la Notice la compte comme Debrief en erreur.",
    see: ["debriefprompt", "record"],
  },
  { ...MOD, couples: ["debriefprompt", "client", "record"] },
);

add(
  "mod",
  "client",
  "cli-client.ts",
  "bun main.ts <cmd> --json · dernière ligne",
  {
    kicker: "src/mod/cli-client.ts",
    title: "Le client du CLI",
    lead: "<code>runCli</code> lance <code>bun &lt;plugin&gt;/src/cli/main.ts &lt;commande&gt; --json</code> par <code>$.process.run</code>, envoie le JSON sur stdin, lit la dernière ligne de stdout. Un code de sortie non nul lève <code>CliError</code> avec la dernière ligne de stderr.",
    io: [
      ["Reçoit", "des arguments et un corps JSON"],
      ["Produit", "la ligne JSON décodée : config, status, {id}, RecordAnswer, {ok}"],
    ],
    swap: "Chaque forme JSON a son pendant dans le CLI (LogStdin, RecordStdin, DecideStdin, StatusReport, RecordOutcome) : changer l'un change l'autre.",
    facts: [
      ["Délais", "30 s par défaut · debrief record 120 s · review decide 10 min"],
      ["Fire-and-forget", "gate log ; une erreur va au journal de debug"],
    ],
    see: ["main"],
  },
  { ...MOD, couples: ["main"] },
);

add(
  "mod",
  "notice",
  "notice.ts",
  "noticeLine → $.ui.status",
  {
    kicker: "src/mod/notice.ts",
    title: "La Notice",
    lead: "Une ligne de statut, posée une fois au démarrage de la session depuis <code>hindsight status</code> : « N Proposal(s) en attente · /hindsight review », « N Debrief(s) en erreur · /hindsight status », ou rien. Claude ne la lit pas.",
    io: [
      ["Reçoit", "pendingProposals et failures de status"],
      ["Produit", "le texte de la ligne, ou undefined qui l'efface"],
    ],
    warn: "Rien ne rafraîchit la ligne après une Décision, et le compte d'erreurs est celui des dix derniers Debriefs en échec, sans fenêtre de temps : il ne redescend jamais.",
    see: ["statusdoctor"],
  },
  { ...MOD, couples: ["statusdoctor"] },
);

add(
  "mod",
  "pane",
  "review-pane.tsx",
  "Pane · a m r h n · Input ⏎",
  {
    kicker: "src/mod/review-pane.tsx",
    title: "Le panneau de Review",
    lead: 'Dessine une Proposal par écran : chemin et dépôt, Verdict et Prevalence, la revendication, le diff (<code>Code format="diff"</code>) ou la description, le raisonnement, la Lesson, un bouton par preuve qui déplie le message masqué. Cinq touches : Accepter, Modifier, Rejeter, Handoff, Suivant. Il ne décide rien : chaque pression appelle <code>review decide</code>.',
    io: [
      [
        "Reçoit",
        "les items de review list, chacun vérifié par isPaneItem (une forme inconnue fait échouer la commande), l'état hindsight.review de $.state, les brouillons en cours de saisie",
      ],
      ["Produit", "les corps de review decide : accept (edits ou null), reject (raison), handoff"],
    ],
    swap: "Une page locale brancherait les mêmes commandes du port ; le panneau n'a pas de logique à reproduire.",
    facts: [
      ["Taille", "largeur max(30, colonnes − 2), 30 lignes, textes coupés à 600 et messages à 2 000"],
      ["Édition", "un Input par modification, ⏎ marque un saut de ligne"],
      ["Rejet", "une raison vide affiche « Un rejet demande une raison. »"],
    ],
    warn: "Le panneau garde le compte des Proposals en attente mais ne l'affiche pas, et ne recharge pas la passe suivante : après la troisième décision il dit « Aucune Proposal en attente », et il faut relancer <code>/hindsight review</code>.",
    see: ["port", "proposal"],
  },
  { ...MOD, couples: ["port", "proposal", "redact"] },
);
