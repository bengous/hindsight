import { expect, test } from "bun:test";

import { validate } from "./check.ts";

test("the plan's data holds together", () => {
  expect(validate()).toEqual([]);
});
