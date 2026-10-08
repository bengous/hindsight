import { describe, expect, test } from "bun:test";
import { cleanHumanText, isDictatedPaste } from "./human.ts";

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
