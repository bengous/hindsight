import { describe, expect, test } from "bun:test";
import { cleanHumanText, isDictatedPaste, markersFor, slashCommand, type Marker, type MarkerContext } from "./human.ts";
import { foldText } from "./text.ts";

const dictation =
  "Bon, écoute, je pense qu'on peut faire beaucoup plus simple. Aujourd'hui, à mon avis, on découpe trop le travail, et du coup je passe mon temps à relire des plans au lieu de tester.";

describe("isDictatedPaste", () => {
  test("keeps a long first-person dictation without markdown", () => {
    expect(isDictatedPaste(dictation)).toBe(true);
  });

  test.each([
    ["markdown", `## Report\n- ${dictation}`],
    ["bold", `**Note** ${dictation}`],
    [
      "no first person",
      "Le serveur redémarre chaque nuit et les journaux sont tournés après sept jours, sans intervention, puis compressés et envoyés vers le stockage froid du fournisseur.",
    ],
    ["a short agent line", "Je conseille toujours de les archiver."],
    ["a repo path", `${dictation} Le dossier atelier/src/theme/fonts/ contient trois polices.`],
    ["a home path", `${dictation} Je peux vérifier ~/.config/atelier si tu veux.`],
    ["a URL", `${dictation} Voir https://example.invalid/page pour le détail.`],
    ["a terminal transcript", `❯ /clear ❯ ${dictation}`],
  ])("drops a paste with %s", (_shape, body) => {
    expect(isDictatedPaste(body)).toBe(false);
  });
});

describe("cleanHumanText", () => {
  test("removes system reminders and foreign pastes, keeps a dictated paste", () => {
    expect(
      cleanHumanText('ok <system-reminder>hidden</system-reminder> <pasted_content id="1">## Report</pasted_content>'),
    ).toBe("ok");
    expect(cleanHumanText(`<pasted_content>${dictation}</pasted_content>`)).toBe(dictation);
  });

  test("strips the round header of a pasted form and keeps the answers", () => {
    expect(cleanHumanText("Atelier couleurs, round 2\nR2-Q1 : Les deux, selon la saison\nR2-Q2 : Sobre")).toBe(
      "R2-Q1 : Les deux, selon la saison\nR2-Q2 : Sobre",
    );
    expect(cleanHumanText("Atelier plugin\nRound 1\nSources : TODO.md\nNote : je garde le plus simple")).toBe(
      "Atelier plugin\nSources : TODO.md\nNote : je garde le plus simple",
    );
    expect(cleanHumanText("Cuisine, tour 3\nQ1 (four) : Encastré")).toBe("Q1 (four) : Encastré");
  });

  test("keeps a round mention that heads no form answer", () => {
    expect(cleanHumanText("On fait le round 2 demain\nmerci")).toBe("On fait le round 2 demain\nmerci");
    expect(cleanHumanText("Atelier couleurs, round 1")).toBe("Atelier couleurs, round 1");
  });
});

const plain: MarkerContext = { isFirstPrompt: false, afterInterrupt: false, rejectedTools: [] };

const lexical: readonly (readonly [string, Marker])[] = [
  ["Je t'ai déjà dit de lancer les tests", "correction_strong"],
  ["pourquoi tu as supprimé ce fichier ?", "correction_strong"],
  ["Arrête de sur compliquer les choses", "correction_strong"],
  ["I told you to keep it short", "correction_strong"],
  ["Pas besoin de relancer le build tout le temps", "frustration"],
  ["J'en ai marre de ces résumés en fin de réponse", "frustration"],
  ["Désormais, réponds dans l'artefact", "standing_instruction"],
  ["mets ça dans le CLAUDE.md", "standing_instruction"],
];

describe("markersFor", () => {
  test.each(lexical)("%p -> %p", (text, marker) => {
    expect(markersFor(text, plain)).toContain(marker);
  });

  test("reads medium corrections only after the first prompt and only without a strong one", () => {
    expect(markersFor("Non, fais plutôt un plan", plain)).toEqual(["correction_medium"]);
    expect(markersFor("Non, fais plutôt un plan", { ...plain, isFirstPrompt: true })).toEqual([]);
    expect(markersFor("Non, je t'ai dit de faire un plan", plain)).toEqual(["correction_strong"]);
  });

  test("looks for medium corrections in the opening only", () => {
    expect(markersFor(`${"x ".repeat(250)}au lieu de`, plain)).toEqual([]);
  });

  test("sets structural markers from the context", () => {
    expect(
      markersFor("ok", { ...plain, afterInterrupt: true, rejectedTools: ["AskUserQuestion", "ExitPlanMode"] }),
    ).toEqual(["interrupt_followup", "user_rejected", "question_rejected", "plan_rejected"]);
  });

  test("returns nothing for a neutral message", () => {
    expect(markersFor("Ajoute un test pour parse()", plain)).toEqual([]);
  });
});

describe("slashCommand", () => {
  test("reads a command's name and arguments", () => {
    expect(slashCommand("<command-name>/hindsight</command-name><command-args>review</command-args>")).toEqual({
      name: "/hindsight",
      args: "review",
    });
    expect(slashCommand("plain text")).toBeNull();
  });
});

describe("foldText", () => {
  test("drops accents, folds curly apostrophes and case", () => {
    expect(foldText("Désormais J’ai RÉPÉTÉ")).toBe("desormais j'ai repete");
  });
});
