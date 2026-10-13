import { describe, expect, test } from "bun:test";

import { redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
  test("replaces token shapes and assigned secrets, keeps ordinary text", () => {
    const fakeAnthropic = ["sk", "ant", "api03", "x".repeat(30)].join("-");
    const fakeGithub = `ghp_${"a".repeat(36)}`;
    const text = `use ${fakeAnthropic} then ${fakeGithub}; password=hunter2 and token: "abc def"`;
    expect(redactSecrets(text)).toBe("use [REDACTED] then [REDACTED]; password=[REDACTED] and token: [REDACTED]");
    expect(redactSecrets("arrête de régénérer les snapshots")).toBe("arrête de régénérer les snapshots");
  });

  test("removes a whole private key block", () => {
    const block = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaA==", "-----END OPENSSH PRIVATE KEY-----"].join(
      "\n",
    );

    expect(redactSecrets(`key:\n${block}\ndone`)).toBe("key:\n[REDACTED]\ndone");
  });
});
