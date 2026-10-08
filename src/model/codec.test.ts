import { describe, expect, test } from "bun:test";
import { array, decode, DecodeError, nullable, object, oneOf, string } from "./codec.ts";

const item = object({
  id: string({ minLength: 1 }),
  kind: oneOf(["explicit", "inferred"]),
  hint: nullable(string()),
});

describe("codec", () => {
  test("decodes a valid value and describes it as a strict JSON schema", () => {
    expect(decode(array(item), [{ id: "a", kind: "explicit", hint: null }])).toEqual([
      { id: "a", kind: "explicit", hint: null },
    ]);
    expect(item.schema).toEqual({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["explicit", "inferred"] },
        hint: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["id", "kind", "hint"],
      additionalProperties: false,
    });
  });

  test("names the path of the first violation", () => {
    const cases: readonly [unknown, string][] = [
      [[{ id: "", kind: "explicit", hint: null }], "$[0].id"],
      [[{ id: "a", kind: "other", hint: null }], "$[0].kind"],
      [[{ id: "a", kind: "explicit" }], "$[0].hint"],
      [[{ id: "a", kind: "explicit", hint: null, extra: 1 }], "$[0]"],
      [{ id: "a" }, "$"],
    ];
    for (const [value, path] of cases) {
      expect(() => decode(array(item), value)).toThrow(DecodeError);
      try {
        decode(array(item), value);
      } catch (error) {
        expect(error instanceof DecodeError && error.path).toBe(path);
      }
    }
  });

  test("enforces maxItems", () => {
    expect(() => decode(array(string(), { maxItems: 1 }), ["a", "b"])).toThrow("at most 1 items");
  });
});
