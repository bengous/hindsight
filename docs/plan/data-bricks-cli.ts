import type { Brick } from "./model.ts";

import { brickAdder } from "./model.ts";

export const bricksCli: Brick[] = [];

const add = brickAdder(bricksCli);

const CLI = { color: "--z-cli" } as const;

add(
  "cli",
  "main",
  "main.ts · app.ts",
  "commandes Effect · appLayer · printJson",
  {
    kicker: "src/cli/main.ts · app.ts · config.ts",
    title: "L'entrée du CLI",
    lead: "La commande <code>hindsight</code> et ses sous-commandes, construites avec Effect : chaque commande reçoit AppPaths, AppConfig et Store, lit stdin en JSON décodé par un Schema, et imprime une seule ligne JSON. Un JSON ou un schéma invalide fait échouer le processus.",
    io: [
      ["Reçoit", "argv et stdin du mod (ou de vous)"],
      ["Produit", "une ligne JSON par commande, un code de sortie"],
    ],
    facts: [
      [
        "Commandes",
        "config · status · doctor · gate log|replay · debrief start|record · learn · prune · review list|decide · handoff prepare",
      ],
      ["Config", "config.json absent : les défauts ; JSON invalide : erreur « <path>: invalid JSON »"],
    ],
    warn: "La couche Store est fournie à la racine : chaque sous-commande ouvre et migre la base, <code>config</code> et <code>gate replay</code> compris.",
    see: ["client", "db"],
  },
  { ...CLI, couples: ["client"] },
);

add(
  "cli",
  "record",
  "debrief/record.ts",
  "vérifie chaque Note · stocke · déclenche Learn",
  {
    kicker: "src/debrief/record.ts · src/cli/debrief.ts",
    title: "debrief record",
    lead: "La vérification d'une réponse de Debrief, dans une transaction. D'abord le plancher de cache, puis la session, puis le JSON. Ensuite chaque Note : une Quote doit figurer mot pour mot (blancs près) dans le message humain le plus ancien qui la contient ; une Observation doit nommer l'outil exact et un extrait d'au moins 12 caractères de son entrée ou de sa sortie ; une Stale Rule doit correspondre à une édition réelle, à un fichier qui porte encore l'extrait, et à un texte de règle présent une seule fois.",
    io: [
      ["Reçoit", "sessionId, cacheShare, durationMs, le texte du fork, repoRoot"],
      [
        "Produit",
        "la ligne debriefs (recorded ou failed), les messages cités, les Notes, une Proposal par Stale Rule confirmée, les comptes de rejet ; learnStarted",
      ],
    ],
    facts: [
      ["Échecs", "cache:<part> · session-not-found · parse:<raison>"],
      [
        "Rejets comptés",
        "quote-missing · quote-from-tool · observation-missing · stale-edit-missing · stale-file-changed · stale-rule-text · ledger-rejected",
      ],
      ["Learn", "spawn détaché learn --if-due dès 8 Notes en attente, sauf HINDSIGHT_NO_LEARN"],
    ],
    warn: "Les Stale Rules deviennent des Proposals ici, source <code>debrief</code>, et leurs Notes naissent <code>used</code> ; la SPEC et l'ADR 0003 attribuent ce travail à Prune. Une empreinte rejetée une fois bloque pour toujours sur ce chemin, sans comparaison de sessions.",
    see: ["debriefprompt", "reader", "learn"],
  },
  { ...CLI, couples: ["debriefprompt", "reader", "queries", "learn"] },
);

add(
  "cli",
  "reader",
  "transcripts/",
  "read · session · continuations · Loaded Rules",
  {
    kicker: "src/transcripts/read.ts · session.ts · json.ts",
    title: "La lecture des transcripts",
    lead: "Retrouve <code>*/&lt;session&gt;.jsonl</code> sous le dossier des projets, remonte la chaîne des prédécesseurs par <code>continuedInSessionId</code>, et lit chaque ligne : les messages humains (origine <code>human</code> seulement, nettoyés comme dans le mod), les appels d'outils avec leur résultat, les interruptions, les Rule Files chargées depuis les pièces jointes.",
    io: [
      ["Reçoit", "un identifiant de session, un dossier de projets"],
      ["Produit", "un SessionRecord : chaîne, cwd, interactif ou non, événements dans l'ordre, Loaded Rules"],
    ],
    facts: [
      ["Humain", "ni toolUseResult, ni isMeta, ni compact, ni sdk ; une commande slash garde ses arguments"],
      [
        "Outil",
        "inputText = JSON.stringify(input), outputText = blocs de texte, isRefused = toolDenialKind user-rejected",
      ],
      ["Ligne cassée", "la dernière ligne partielle est ignorée, toute autre lève « invalid JSON line »"],
    ],
    warn: "Un extrait d'entrée d'outil se cherche dans la forme JSON échappée : un extrait avec un saut de ligne ou un guillemet ne peut pas correspondre.",
    see: ["transcripts", "humantext"],
  },
  { ...CLI, couples: ["transcripts", "humantext"] },
);

add(
  "cli",
  "replay",
  "gate/replay.ts",
  "gate replay --days 30",
  {
    kicker: "src/gate/replay.ts",
    title: "Le rejeu du Portail",
    lead: "Rejoue le code du Portail sur vos transcripts des N derniers jours, sans modèle : tours reconstruits, sauts, histogramme des scores, part de tours qui passent, briefs d'exemple. C'est ce rejeu qui a déplacé le seuil de 0,35 à 1,0.",
    io: [
      ["Reçoit", "le dossier des projets, le nombre de jours, la configuration"],
      ["Produit", "files, sessions, turns, passed, sessionsWithPass, skipped, scoreHistogram, sampleBriefs"],
    ],
    facts: [["Chiffres", "679 sessions, 3 877 tours, 12 % de tours qui passent le code au seuil 1,0"]],
    warn: "Le rejeu diverge du mod : les marqueurs sont posés sur des faits vides à chaque tour (turnsOf), donc correction_medium et user_rejected ne s'allument jamais ici (vérifié par script) ; le dépôt exclu se compare au cwd et non à la racine git ; les continuations ne sont pas suivies ; aucun classifieur ne tourne.",
    see: ["gaterules", "reader"],
  },
  { ...CLI, couples: ["gaterules", "gate", "reader", "facts"] },
);

add(
  "cli",
  "learn",
  "learn/run.ts · claude.ts",
  "réservation · groupes · un appel par dépôt",
  {
    kicker: "src/learn/run.ts · src/learn/claude.ts · src/cli/learn.ts",
    title: "Learn",
    lead: "Un passage : réserver (échouer les passages périmés, expirer les Notes de plus de 30 jours, vérifier <code>--if-due</code>, prendre le verrou), lire les Notes en attente et le Ledger, inventorier les Rule Files, former un groupe par dépôt plus un groupe global quand deux dépôts se croisent, un appel <code>claude -p</code> par groupe sous budget, passer les candidats aux portes, insérer les Proposals, marquer les Notes utilisées, puis Prune.",
    io: [
      ["Reçoit", "les Notes pending de la fenêtre, les Rule Files, les Loaded Rules des sessions, le Ledger"],
      [
        "Produit",
        "des Proposals source learn, une ligne learn_runs avec son coût, un rapport {status, groups, proposals, dropped, failures, costUsd}",
      ],
    ],
    facts: [
      [
        "Appel",
        'claude --print --safe-mode --no-session-persistence --model opus --effort high --tools "" --strict-mcp-config --permission-mode dontAsk --output-format json --json-schema … --max-budget-usd …',
      ],
      ["Bornes", "2 $ par passage, 0,02 $ minimum par appel, 15 min par appel, SIGKILL ensuite"],
      ["Verrou", "une seule ligne running ; périmée après 2 h"],
    ],
    warn: "Un processus mort bloque Learn jusqu'à deux heures. Le rapport dit <code>failed</code> seulement quand aucun groupe n'a produit de Proposal.",
    see: ["learncontract", "claudep", "prune"],
  },
  { ...CLI, couples: ["learncontract", "claudep", "queries", "prune", "inventory", "humantext"] },
);

add(
  "cli",
  "learncontract",
  "learn/prompt.ts · schema.ts · gates.ts",
  "prompt · JSON Schema · 13 portes",
  {
    kicker: "src/learn/prompt.ts · schema.ts · gates.ts",
    title: "Le contrat de Learn",
    lead: "Trois fichiers qui changent ensemble : le prompt décrit les champs et les Verdicts en prose, <code>LearnOutputSchema</code> les type et produit le JSON Schema passé à <code>claude -p</code>, et <code>gateLearn</code> les vérifie en code. Le modèle regroupe et rédige ; le code refuse ce qu'il ne peut pas prouver.",
    io: [
      [
        "Reçoit",
        "les candidats décodés : verdict, cible, noteIds, ruleBulletIds, textes, change, isWatchTask, singleSessionJustification",
      ],
      ["Produit", "les Proposals gardées, les comptes de rejet par porte"],
    ],
    facts: [
      [
        "Portes, dans l'ordre",
        "id inconnu (tout le groupe) · no-evidence · watch-task · hold · <verdict>-without-rule · below-threshold · unknown-target · new-file-outside-rules · global-group-repo-target · global-one-repo · style · empty-edit · old-text-not-found · old-text-ambiguous · ledger-rejected · already-proposed · duplicate-evidence",
      ],
      [
        "Seuil",
        "3 sessions et 2 jours, ou une Steer explicite, ou conflict sur une règle chargée, ou une justification avec une Observation",
      ],
      ["Style refusé", "dates, hashes, vN.N, « currently », « no longer », « replaced by »…"],
    ],
    warn: "Le champ <code>scope</code> du modèle est décodé puis ignoré : la portée vient du fichier cible. Les textes de preuve partent au prompt masqués mais sont stockés bruts dans la Proposal.",
    see: ["learn", "proposal"],
  },
  { ...CLI, couples: ["learn", "proposal"] },
);

add(
  "cli",
  "prune",
  "learn/prune.ts · rules/stale.ts",
  "globs morts · chemins · scripts",
  {
    kicker: "src/learn/prune.ts · src/rules/stale.ts",
    title: "Prune",
    lead: "Sans modèle. Pour chaque Rule File d'un dépôt : un motif <code>paths:</code> qui ne trouve aucun fichier, un chemin cité en code inline qui n'existe plus, un <code>bun run &lt;script&gt;</code> absent des package.json. Chaque trouvaille devient une Proposal en description, source prune, filtrée par le Ledger.",
    io: [
      ["Reçoit", "des racines de dépôt (celles de Learn, ou notes ∪ proposals plus --repo)"],
      [
        "Produit",
        "des Proposals description, scope repo, Prevalence 0 session ; un rapport {repos, findings, proposals, skipped}",
      ],
    ],
    facts: [["Empreinte", String.raw`sha1("stale\n" + id de la trouvaille)`]],
    warn: "Une description ne s'accepte pas : seul un Handoff ou un rejet la ferme. Les fichiers globaux sont sautés, alors que la SPEC dit « chaque Rule File ». Une empreinte rejetée une fois bloque pour toujours.",
    see: ["inventory", "learn"],
  },
  { ...CLI, couples: ["inventory", "learn"] },
);

add(
  "cli",
  "port",
  "review/port.ts",
  "review list · decide · handoff prepare",
  {
    kicker: "src/review/port.ts · src/cli/review.ts",
    title: "Le port de la Review",
    lead: "Les décisions vivent ici. <code>review list</code> règle d'abord les Proposals en attente (une plus récente sur la même clé remplace l'ancienne ; une modification dont l'ancien texte a disparu expire), trie par Prevalence puis par âge, coupe à trois. <code>review decide</code> accepte, rejette ou met en Handoff ; un accept réserve la ligne avant d'écrire le fichier et la libère si l'application est refusée.",
    io: [
      ["Reçoit", "{id, decision: accept (edits|null) | reject (reason) | handoff}"],
      [
        "Produit",
        "{kind: accepted (apply) | rejected | handed_off | refused (reason)} ; pour prepare, les instructions sans Quote",
      ],
    ],
    facts: [
      ["Clé de remplacement", "chemin + bullet_id, ou le premier oldText, ou l'id"],
      ["Ledger", "decisions : accepted, rejected, handed_off ; remplacement et expiration n'y laissent rien"],
      ["Masquage", "redactSecrets à la lecture ; le message de commit se contrôle contre les textes bruts"],
    ],
    warn: "reject et handoff relisent la ligne mais ne revérifient pas <code>pending</code> dans leur transaction ; seul accept réserve. Une création de fichier (oldText vide) n'expire jamais.",
    see: ["proposal", "apply", "pane"],
  },
  { ...CLI, couples: ["proposal", "apply", "pane", "queries"] },
);

add(
  "cli",
  "inventory",
  "rules/inventory.ts · markdown.ts · glob.ts",
  "Rule Files · bullets · @imports · globs",
  {
    kicker: "src/rules/inventory.ts · markdown.ts · glob.ts · ids.ts",
    title: "L'inventaire des Rule Files",
    lead: "Les fichiers globaux (<code>~/.claude/CLAUDE.md</code>, <code>AGENTS.md</code>, <code>rules/**</code>, <code>output-styles/*</code>) puis ceux de chaque checkout par <code>git ls-files</code> : AGENTS.md et CLAUDE.md à toute profondeur, <code>.claude/rules/**.md</code>, les styles à la racine, les <code>@imports</code> jusqu'à quatre sauts. Chaque fichier donne sa portée, ses <code>paths</code> et ses bullets identifiés par un hash de leur texte.",
    io: [
      ["Reçoit", "des racines de checkout (égales à leur toplevel git, sinon erreur)"],
      ["Produit", "des RuleFile : sourcePath réel, scope global|repo|path, paths, bullets {id, line, text}"],
    ],
    facts: [
      ["Scope", "racine : repo ; sous-dossier : path avec <dir>/** implicite"],
      ["Empreinte", "sha1(targetPath + lesson normalisée) ; la changer orphelinerait chaque rejet passé"],
    ],
    warn: "Une Stale Rule de Debrief vise le chemin chargé, Learn le chemin réel (realpath) : un même fichier peut avoir deux empreintes (déduit du code, non testé).",
    see: ["rulefiles", "prune", "learn"],
  },
  { ...CLI, couples: ["rulefiles", "prune", "learn"] },
);

add(
  "cli",
  "apply",
  "rules/apply.ts · git.ts",
  "applyChange · commit d'un fichier",
  {
    kicker: "src/rules/apply.ts · src/rules/git.ts",
    title: "L'application d'un accept",
    lead: "Un fichier global hors dépôt : une écriture. Un fichier dans un checkout : le fichier doit exister (ou non, pour une création), être propre dans <code>git status</code>, et chaque ancien texte y figurer exactement une fois ; puis <code>git add</code> au besoin et <code>git commit --quiet --file=- -- &lt;chemin&gt;</code>, hooks actifs. Un commit refusé restaure le fichier.",
    io: [
      [
        "Reçoit",
        "la cible, le dépôt, les éditions, le message (sujet, Lesson, comptes de preuves, id de Proposal), les extraits bruts",
      ],
      [
        "Produit",
        "committed (sha) · written (chemin) · refused : outside-checkout · invalid-edit · excerpt-in-message · file-exists · file-missing · ignored-path · dirty-file · old-text-missing · old-text-ambiguous · commit-rejected",
      ],
    ],
    facts: [
      ["Git", "GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_PREFIX, GIT_OBJECT_DIRECTORY retirés ; 30 s par commande"],
      ["Message", "un extrait brut de 12 caractères ou plus dans le message le refuse"],
    ],
    see: ["checkout", "rulefiles", "port"],
  },
  { ...CLI, couples: ["checkout", "port"] },
);

add(
  "cli",
  "statusdoctor",
  "status.ts · doctor.ts",
  "état · santé · aborte les Debriefs perdus",
  {
    kicker: "src/cli/status.ts · doctor.ts",
    title: "status et doctor",
    lead: "<code>status</code> compte les Debriefs par état, la part de cache min et moyenne, les dix derniers échecs, les Notes et Proposals en attente, les décisions du Portail par raison, les passages de Learn et leur coût. <code>doctor</code> vérifie le dossier d'état (0700), la base (0600, version de schéma), la configuration, les transcripts, <code>claude</code> et <code>bun</code>.",
    io: [
      ["Reçoit", "rien"],
      ["Produit", "StatusReport ; {ok, checks}"],
    ],
    warn: "<code>status</code> écrit : il passe en <code>aborted</code> toute ligne <code>started</code> de plus de 15 minutes. Rien d'autre ne le fait, et un fork plus long qu'un quart d'heure perd son enregistrement si status tourne entre-temps.",
    see: ["notice"],
  },
  { ...CLI, couples: ["notice", "queries"] },
);

// ---------- the store ----------
const STORE = { color: "--z-store" } as const;

add(
  "store",
  "db",
  "db.ts",
  "Store · transaction · WAL · busy 5 s",
  {
    kicker: "src/store/db.ts",
    title: "Le service Store",
    lead: "Un service Effect sur <code>bun:sqlite</code> : <code>run</code>, <code>all</code>, <code>get</code>, et <code>transaction</code> qui exécute un corps synchrone dans une transaction SQLite, annulée par un throw. À l'ouverture : dossier 0700, fichier 0600 s'il est neuf, WAL, busy_timeout 5 s, clés étrangères, puis les migrations.",
    io: [
      ["Reçoit", "du SQL paramétré"],
      ["Produit", "des lignes, un nombre de changements, StoreError {operation, cause}"],
    ],
    warn: "Les fichiers -wal et -shm ne reçoivent pas de chmod explicite (non vérifié à l'exécution).",
    see: ["migrations", "queries", "paths"],
  },
  { ...STORE, couples: ["migrations", "queries", "paths"] },
);

add(
  "store",
  "migrations",
  "migrations.ts",
  "8 tables · user_version 3",
  {
    kicker: "src/store/migrations.ts",
    title: "Le schéma",
    lead: "Trois migrations numérotées, jouées chacune dans sa transaction, <code>PRAGMA user_version</code> fixant ce qui a tourné. Une entrée livrée ne se modifie jamais ; un changement de schéma est une entrée de plus à la fin.",
    facts: [
      [
        "debriefs",
        "id, session_id, repo_root, status (started|recorded|aborted|failed), started_at, finished_at, cache_share, duration_ms, failure, rejected_json, answer",
      ],
      ["gate_decisions", "session_id, at, turn_id, decision, reason, score, signals_json"],
      ["messages", "evidence_id, session_id, at, repo_root, text (non masqué)"],
      [
        "notes",
        "debrief_id, session_id, repo_root, at, kind (steer|observation|stale_rule), status (pending|used|expired), evidence_id, lesson, body_json, loaded_rules_json",
      ],
      [
        "proposals",
        "fingerprint, created_at, state, source (learn|prune|debrief), target_path, repo_root, scope, verdict, claim_fr, reasoning_fr, lesson_en, subject_en, change_json, evidence_json, prevalence_json, bullet_id, learn_run_id",
      ],
      [
        "decisions",
        "le Ledger : proposal_id, fingerprint, at, decision (accepted|rejected|handed_off), reason, edited_change_json, sessions_at_decision, commit_sha, drift_json",
      ],
      [
        "learn_runs",
        "started_at, finished_at, status (running|complete|failed), notes_read, proposals_written, cost_usd, failure",
      ],
      ["handoffs", "created_at, proposal_ids_json, instructions"],
    ],
    warn: "Les listes CHECK de SQL doublent des unions TypeScript (DebriefStatus, ProposalState, NoteRow.status…) que rien ne vérifie l'une contre l'autre. <code>decisions.drift_json</code> n'est jamais écrit.",
    see: ["queries"],
  },
  { ...STORE, couples: ["queries", "proposal"] },
);

add(
  "store",
  "queries",
  "queries.ts",
  "lignes typées · insertions · verrous",
  {
    kicker: "src/store/queries.ts",
    title: "Les requêtes",
    lead: "Les types de ligne (DebriefRow, NoteRow, ProposalRow, ProposalInsert, Change, Evidence, Prevalence) et chaque requête nommée : ouvrir et clore un Debrief, insérer messages, Notes et Proposals, réserver un passage de Learn, expirer les Notes, lire le Ledger, compter.",
    io: [
      ["Reçoit", "les appels de record, learn, prune, port, status"],
      ["Produit", "des lignes typées par cast, sans décodage à l'exécution"],
    ],
    facts: [
      ["Verrou de Learn", "une seule ligne running ; failStaleLearnRuns après 2 h"],
      ["Debrief perdu", "abortStaleDebriefs après 15 min, appelé par status seulement"],
    ],
    warn: "Le SQL brut de status.ts, port.ts et prune.ts doit changer avec le schéma ; <code>countDebriefsSince</code> n'a aucun appelant.",
    see: ["migrations", "db"],
  },
  { ...STORE, couples: ["record", "learn", "port", "statusdoctor"] },
);

add(
  "store",
  "paths",
  "paths.ts",
  "XDG · 0700 · logs de Learn",
  {
    kicker: "src/store/paths.ts",
    title: "Les chemins",
    lead: "<code>$XDG_STATE_HOME/hindsight</code> pour la base et les logs des passages détachés de Learn, <code>$XDG_CONFIG_HOME/hindsight/config.json</code> pour la configuration, <code>$HINDSIGHT_PROJECTS_DIR</code> ou <code>~/.claude/projects</code> pour les transcripts. Le dossier d'état est remis en 0700 à chaque passage.",
    io: [
      ["Reçoit", "HOME, XDG_STATE_HOME, XDG_CONFIG_HOME, HINDSIGHT_PROJECTS_DIR"],
      ["Produit", "stateRoot, dbPath, configPath, logDir, projectsDir"],
    ],
    see: ["config", "transcripts"],
  },
  { ...STORE, couples: ["config"] },
);
