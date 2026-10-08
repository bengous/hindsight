import type { Marker } from "../types.ts";
import { describe, expect, test } from "bun:test";
import { foldText, markersFor, type MarkerContext } from "./markers.ts";

const plain: MarkerContext = {
  isFirstPrompt: false,
  afterInterrupt: false,
  rejectedTools: [],
  isRejectionFeedback: false,
};

const lexical: readonly (readonly [string, Marker])[] = [
  ["Je t'ai déjà dit de lancer les tests", "correction_strong"],
  ["pourquoi tu as supprimé ce fichier ?", "correction_strong"],
  ["Arrête de sur compliquer les choses", "correction_strong"],
  ["I told you to keep it short", "correction_strong"],
  ["Pas besoin de relancer le build tout le temps", "frustration"],
  ["pas besoin d'en recréer une", "frustration"],
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
    expect(markersFor("trop long", { ...plain, isRejectionFeedback: true })).toEqual(["user_rejected"]);
  });

  test("returns nothing for a neutral message", () => {
    expect(markersFor("Ajoute un test pour parse()", plain)).toEqual([]);
  });
});

describe("foldText", () => {
  test("drops accents, folds curly apostrophes and case", () => {
    expect(foldText("Désormais J’ai RÉPÉTÉ")).toBe("desormais j'ai repete");
  });
});
