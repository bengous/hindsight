import type { Proposal } from "../../src/types.ts";

export const mockNow = new Date("2026-10-08T09:00:00Z");

export const mockBulletText: ReadonlyMap<string, string> = new Map([
  ["AGENTS.md#5c1e0a7d", "- Write dates in ISO format, year first."],
]);

export const mockProposals: readonly Proposal[] = [
  {
    id: "p-factory",
    fingerprint: "f-factory",
    kind: "missing",
    lesson: "Build Order objects in tests with the makeOrder() factory.",
    commitSubject: "Use the makeOrder factory in tests",
    title: "Les agents écrivent les objets Order à la main dans les tests au lieu d'utiliser la fabrique makeOrder().",
    why: "Corrigé dans 5 sessions sur 4 jours, toujours dans des fichiers *.test.ts ; la règle de tests est chargée sur ces chemins mais ne mentionne pas la fabrique, qui existe bien dans src/testing/factories.ts.",
    target: {
      repoRoot: "/home/user/Work/atelier",
      sourcePath: "/home/user/Work/atelier/.claude/rules/tests.md",
      blobHash: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
    },
    op: {
      op: "add",
      sourcePath: "/home/user/Work/atelier/.claude/rules/tests.md",
      edits: [
        {
          oldText: "- Tests live next to the code they cover.",
          newText:
            "- Tests live next to the code they cover.\n- Build orders with `makeOrder()` from `src/testing/factories.ts`; never write an Order literal by hand.",
        },
      ],
    },
    suggestion: null,
    ruleBulletIds: [],
    prevalence: { sessions: 5, days: 4, repos: 1, firstAt: "2026-09-14T08:12:00Z", lastAt: "2026-10-06T16:40:00Z" },
    evidence: [
      {
        evidenceId: "s-001:u-01",
        sessionTitle: "Ajout remise fidélité",
        timestamp: "2026-09-14T08:12:00Z",
        quote: "utilise la fabrique makeOrder, pas un objet écrit à la main",
      },
      {
        evidenceId: "s-002:u-07",
        sessionTitle: "Fix arrondi TVA",
        timestamp: "2026-09-22T10:03:00Z",
        quote: "pourquoi tu recrées un Order complet dans le test ? on a makeOrder pour ça",
      },
      {
        evidenceId: "s-003:u-02",
        sessionTitle: "Export CSV commandes",
        timestamp: "2026-09-22T15:47:00Z",
        quote: "encore un Order en dur… passe par la fabrique",
      },
      {
        evidenceId: "s-004:u-11",
        sessionTitle: "Refacto panier",
        timestamp: "2026-10-01T09:30:00Z",
        quote: "makeOrder() existe, sers-t'en",
      },
      {
        evidenceId: "s-005:u-04",
        sessionTitle: "Bug livraison gratuite",
        timestamp: "2026-10-06T16:40:00Z",
        quote: "même remarque que d'habitude : fabrique, pas de littéral",
      },
    ],
    confidence: "high",
  },
  {
    id: "p-commit-hook",
    fingerprint: "f-commit-hook",
    kind: "ignored",
    lesson: "Enforce ISO dates with a pre-commit hook.",
    commitSubject: "Enforce ISO dates with a hook",
    title:
      "La règle sur les dates au format ISO 8601 est chargée mais violée dans 3 sessions : la prose ne suffit plus.",
    why: "La règle était dans le contexte des 3 sessions (fichier AGENTS.md chargé au démarrage). Une règle chargée et violée 2 fois ou plus passe à l'échelon suivant : un contrôle automatique plutôt qu'une phrase de plus.",
    target: {
      repoRoot: "/home/user/Work/atelier",
      sourcePath: "/home/user/Work/atelier/AGENTS.md",
      blobHash: "9f2c4e6a11b0d3c57e8a9b2d4f6c8e0a1b3d5f70",
    },
    op: null,
    suggestion:
      "Ajouter un hook pre-commit qui refuse une date au format JJ/MM (« 12/10 », « 03/04 ») dans le code, puis retirer la phrase d'AGENTS.md.",
    ruleBulletIds: ["AGENTS.md#5c1e0a7d"],
    prevalence: { sessions: 3, days: 3, repos: 2, firstAt: "2026-09-18T13:20:00Z", lastAt: "2026-10-04T11:05:00Z" },
    evidence: [
      {
        evidenceId: "s-006:u-03",
        sessionTitle: "Migration schéma clients",
        timestamp: "2026-09-18T13:20:00Z",
        quote: "la date est en JJ/MM, je t'ai dit le format ISO",
      },
      {
        evidenceId: "s-007:u-09",
        sessionTitle: "Pagination API",
        timestamp: "2026-09-27T17:02:00Z",
        quote: "« 12/10 » non : « 2026-10-12 »",
      },
      {
        evidenceId: "s-008:u-05",
        sessionTitle: "Nettoyage logs",
        timestamp: "2026-10-04T11:05:00Z",
        quote: "encore une date en JJ/MM",
      },
    ],
    confidence: "medium",
  },
  {
    id: "p-draft-pr",
    fingerprint: "f-draft-pr",
    kind: "conflict",
    lesson: "Write the migration once the schema change is complete.",
    commitSubject: "Open one PR per finished change",
    title:
      "La règle « créer une migration dès le premier champ » contredit ta consigne de livrer une seule migration finale.",
    why: "Une seule session, mais la consigne est explicite et vise directement une règle chargée. À confirmer : elle visait peut-être ce seul chantier.",
    target: {
      repoRoot: "/home/user/Work/carnet",
      sourcePath: "/home/user/Work/carnet/AGENTS.md",
      blobHash: "e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e",
    },
    op: {
      op: "update",
      sourcePath: "/home/user/Work/carnet/AGENTS.md",
      edits: [
        {
          oldText: "- Create a migration as soon as a field changes.",
          newText: "- Write the migration once the schema change is complete: one migration per change.",
        },
      ],
    },
    suggestion: null,
    ruleBulletIds: ["AGENTS.md#77a0b1c2"],
    prevalence: { sessions: 1, days: 1, repos: 1, firstAt: "2026-10-03T19:44:00Z", lastAt: "2026-10-03T19:44:00Z" },
    evidence: [
      {
        evidenceId: "s-009:u-02",
        sessionTitle: "Import des notes Markdown",
        timestamp: "2026-10-03T19:44:00Z",
        quote: "arrête de créer une migration par champ, je veux une seule migration quand c'est fini",
      },
    ],
    confidence: "low",
  },
];
