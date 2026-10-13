import type { Info, Zone } from "./model.ts";

// Every `info` feeds the right panel, fields in the order it shows them:
//   kicker  mono line above the title: the source files
//   title, lead
//   io      [["Reçoit", …], ["Produit", …]]: the contract
//   swap    what to touch to replace it ("Pour remplacer")
//   extend  the planned way to grow it ("Pour étendre")
//   why     reasons for the current choice
//   alt     alternatives rejected or postponed
//   facts   [label, value] pairs
//   warn    one open point, boxed
//   how     reading instructions
//   see     ids of related zones or bricks, as chips
//   src     longer source reference
export const OVERVIEW: Info = {
  kicker: "AGENTS.md · SPEC.md · docs/adr/",
  title: "hindsight",
  lead: "Deux moitiés et un noyau partagé. Le mod vit dans la session Claude Code : il capte, décide vite, forke et dessine, sans Node ni base. Le CLI vit hors bande sur Bun et Effect : il vérifie, stocke, apprend, applique et commit. Entre les deux, <code>src/domain/</code> est pur et sert aux deux.",
  why: [
    "Un mod a 10 s par hook et pas de Node : tout ce qui écrit ou attend passe par le CLI, une ligne JSON par commande (ADR 0004).",
    "Le Debrief doit lire le cache de la session : seul <code>$.model.fork</code> le garantit, un <code>claude -p --resume</code> mesuré sur 57 essais le perdait (ADR 0003, 0004).",
    "Les décisions de la Review vivent derrière un port du CLI : le panneau dessine, une page ferait pareil (ADR 0001, 0005).",
  ],
  facts: [
    ["Mod", "hooks/hooks.json → src/mod/register.ts"],
    ["CLI", "bun src/cli/main.ts <commande>, une ligne JSON"],
    ["État", "$XDG_STATE_HOME/hindsight/hindsight.sqlite, 0700/0600"],
    ["Modèles", "classifieur du moteur, fork sur le modèle de la session, Learn sur Opus"],
  ],
  how: "Chaque zone est un dossier de <code>src/</code> ou un système autour ; chaque brique un composant remplaçable. Un clic sur une zone la cadre ; un clic sur une brique allume ses flèches, entoure en pointillé les briques qui changent avec elle, et le panneau dit ce qu'elle reçoit, ce qu'elle produit et quoi toucher pour la remplacer. Les flèches portent ce qui circule : un hook, une commande, une table, un fichier.",
  src: "AGENTS.md (invariants, layout) · .claude/rules/mod.md · .claude/rules/cli.md",
};

export const ZONES: readonly Zone[] = [
  {
    id: "session",
    title: "Session Claude Code",
    tag: "fil principal interactif · le moteur et ses hooks",
    color: "--z-session",
    kw: ["moteur", "hooks", "cache"],
    info: {
      kicker: "types/claude-code.d.ts · hooks/hooks.json",
      title: "La session Claude Code",
      lead: "La Session : vous et l'agent, sur le poste de travail. Le moteur y tient le cache de prompt, écrit le transcript JSONL et offre au mod une API <code>$</code> : hooks de fonction, modèles, store, interface, processus. hindsight n'y met rien que vous ne voyiez vous-même.",
      why: [
        "Le fork du moteur rejoue la dernière requête du fil principal avec le même modèle, le même système et les mêmes outils : son préfixe vient du cache, et <code>usage.cache_read_input_tokens</code> dit quelle part.",
        "Une session lancée par un outil, un sous-agent, une session de fond ou cloud n'ouvre jamais le Portail : hors de la première version.",
      ],
      facts: [
        ["Hooks", "session.start · prompt.submit · turn.complete · command.run · ui.render"],
        [
          "Mesuré",
          "des forks détachés ont lu tout le préfixe depuis le cache ; hindsight status donne la part de cache des Debriefs (ADR 0004)",
        ],
      ],
      warn: "Un <code>session.compact</code> pendant un Debrief n'est pas couvert : le plan le nomme comme risque, pas comme garantie.",
      see: ["mod", "transcripts"],
      src: "docs/adr/0004 · plans/v2-tasks.md",
    },
  },
  {
    id: "mod",
    parent: "session",
    title: "Le mod hindsight",
    tag: "src/mod · pas de Node, pas de base",
    color: "--z-mod",
    kw: ["capter", "décider", "dessiner"],
    info: {
      kicker: "src/mod/ · .claude/rules/mod.md",
      title: "Le mod hindsight",
      lead: "Le plugin de hooks de fonction. Il capte votre texte, accumule les faits du tour, fait tourner le code du Portail, prend le verrou de fork, interroge le classifieur, lance le fork, mesure la part de cache, puis remet tout au CLI. Il dessine la ligne de statut, les toasts et le panneau de Review.",
      why: [
        "Un seul fichier touche <code>$</code> : <code>register.ts</code>. Le reste lit un <code>Host</code>, ce qui permet des specs avec un faux hôte en plus du kit <code>claude plugin test</code>.",
        "Aucun hook ne met de texte dans le contexte du modèle : <code>command.run</code> répond <code>{}</code>, <code>turn.complete</code> rend ce que <code>next(e)</code> a donné.",
      ],
      facts: [
        ["État de session", "$.store sous session:<id> : TurnFacts et verrou de fork"],
        ["Budget", "10 s par hook ; le temps passé dans $.process.run n'est pas compté"],
        ["Tests", "src/mod/*.test.ts (kit) · src/mod/mod.spec.ts (bun test, faux hôte)"],
      ],
      see: ["domain", "cli"],
      src: ".claude/rules/mod.md",
    },
  },
  {
    id: "domain",
    title: "Le domaine partagé",
    tag: "src/domain · pur",
    color: "--z-domain",
    kw: ["pur", "partagé", "testé"],
    info: {
      kicker: "src/domain/*.ts",
      title: "Le domaine partagé",
      lead: "Les règles sans effet : les faits d'un tour, les sauts et signaux du Portail, le nettoyage et les marqueurs du texte humain, le prompt des cinq questions et son lecteur, les états d'une Proposal, les défauts de configuration, le masquage des secrets, le diff. Le mod et le CLI l'importent tous deux ; cette page le fait tourner dans votre navigateur.",
      why: [
        "Le mod n'a pas de Node : le noyau n'importe ni <code>node:</code>, ni <code>bun:</code>, ni Effect, et <code>rg</code> le vérifie.",
        "Des fonctions pures se lisent et se testent sans Effect : <code>bun test src/domain/gate.spec.ts</code> tourne en quelques millisecondes.",
      ],
      facts: [
        ["Garde", String.raw`rg -n 'from "(node:|bun:|effect)|\bBun\.' src/domain -g '!*.spec.ts' ne trouve rien`],
      ],
      see: ["mod", "cli"],
      src: "AGENTS.md (invariants) · docs/adr/0002",
    },
  },
  {
    id: "cli",
    title: "Le CLI hindsight",
    tag: "bun src/cli/main.ts · Effect 4 · une ligne JSON",
    color: "--z-cli",
    kw: ["vérifier", "apprendre", "appliquer"],
    info: {
      kicker: "src/cli/ · src/debrief/ · src/learn/ · src/review/ · src/rules/ · src/transcripts/",
      title: "Le CLI hindsight",
      lead: "Tout ce qui écrit, attend ou coûte. Chaque commande lit ses entrées sur stdin en JSON, imprime une seule ligne JSON et rien d'autre ; le mod lit la dernière ligne. Il vérifie les Notes contre le transcript, fait tourner Learn et Prune, règle la Review et commit.",
      why: [
        "Effect 4 porte les effets : modèles, git, fichiers, SQLite. Un même <code>Schema</code> décode stdin et dérive le JSON Schema que Learn passe à <code>claude -p</code> (ADR 0002).",
        "Les décisions vivent ici derrière un port : <code>review list</code>, <code>review decide</code>, <code>handoff prepare</code>. Le panneau n'en prend aucune.",
      ],
      facts: [
        [
          "Commandes",
          "config · status · doctor · gate log|replay · debrief start|record · learn · prune · review list|decide · handoff prepare",
        ],
        ["Scratch", "XDG_STATE_HOME, XDG_CONFIG_HOME, HINDSIGHT_PROJECTS_DIR ; HINDSIGHT_NO_LEARN retient Learn"],
      ],
      see: ["store", "domain"],
      src: ".claude/rules/cli.md",
    },
  },
  {
    id: "store",
    parent: "cli",
    title: "L'état",
    tag: "src/store · bun:sqlite · WAL",
    color: "--z-store",
    kw: ["SQLite", "migrations", "0600"],
    info: {
      kicker: "src/store/db.ts · migrations.ts · queries.ts · paths.ts",
      title: "L'état sur disque",
      lead: "Une base SQLite sous <code>$XDG_STATE_HOME/hindsight</code>, dossier 0700, fichier 0600 : les Debriefs et leur part de cache, le journal du Portail, les messages cités, les Notes, les Proposals, le Ledger, les passages de Learn et leur coût, les Handoffs. Le texte de vos transcripts ne sort jamais d'ici.",
      why: [
        "Un service Effect <code>Store</code> sur <code>bun:sqlite</code> : WAL, <code>busy_timeout</code>, une transaction synchrone par <code>Store.transaction</code>.",
        "Les migrations sont numérotées et <code>PRAGMA user_version</code> fixe ce qui a tourné ; une entrée livrée ne se modifie jamais.",
      ],
      see: ["cli"],
      src: ".claude/rules/cli.md · README.md (State)",
    },
  },
];

export const ZONE_ORDER: readonly string[] = ["session", "mod", "domain", "cli", "store"];
