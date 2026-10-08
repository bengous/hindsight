import { describe, expect, test } from "bun:test";
import { quoteContext } from "./context.ts";

const filler = (count: number, word: string): string => Array.from({ length: count }, () => word).join(" ");

describe("quoteContext", () => {
  test("returns a short message whole, with the quote located", () => {
    expect(quoteContext("non, utilise pnpm ici", "utilise pnpm")).toEqual({
      found: true,
      before: "non, ",
      quote: "utilise pnpm",
      after: " ici",
      clippedStart: false,
      clippedEnd: false,
    });
  });

  test("cuts a long message to about the window around the quote, at word boundaries", () => {
    const message = `${filler(200, "avant")} la citation exacte ${filler(200, "après")}`;
    const context = quoteContext(message, "la citation exacte", 600);
    if (!context.found) throw new Error("quote not found");
    const shown = context.before + context.quote + context.after;
    expect(shown.length).toBeLessThanOrEqual(600);
    expect(shown.length).toBeGreaterThan(500);
    expect(context.quote).toBe("la citation exacte");
    expect(context.clippedStart && context.clippedEnd).toBe(true);
    expect(context.before.startsWith("avant")).toBe(true);
    expect(context.after.endsWith("après")).toBe(true);
  });

  test("gives the unused side of the window to the other side", () => {
    const message = `début. la citation ${filler(300, "suite")}`;
    const context = quoteContext(message, "la citation", 600);
    if (!context.found) throw new Error("quote not found");
    expect(context.clippedStart).toBe(false);
    expect((context.before + context.quote + context.after).length).toBeGreaterThan(550);
  });

  test("matches across differences in whitespace runs, as the evidence gate does", () => {
    const context = quoteContext("arrête de\n\n   régénérer   à chaque commit", "de régénérer à chaque");
    expect(context).toMatchObject({ found: true, quote: "de\n\n   régénérer   à chaque" });
  });

  test("redacts secrets before showing the message", () => {
    const context = quoteContext("mets token=abc123secret dans .env puis relance", "puis relance");
    if (!context.found) throw new Error("quote not found");
    expect(context.before).toContain("token=[REDACTED]");
    expect(context.before).not.toContain("abc123secret");
  });

  test("reports a quote it cannot find, with the start of the message", () => {
    expect(quoteContext(`${filler(300, "mot")}`, "absente", 600)).toMatchObject({
      found: false,
      clippedEnd: true,
    });
  });
});
