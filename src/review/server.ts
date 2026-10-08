import type { PendingProposal } from "../state/index.ts";
import type { DecisionReply, DecisionRequest } from "./client.ts";
import { timingSafeEqual } from "node:crypto";
import { checkRequest } from "./decide.ts";
import { renderPage } from "./page.ts";
import { selectRound } from "./round.ts";

export type ReviewServerOptions = {
  readonly pending: () => Promise<readonly PendingProposal[]>;
  readonly bulletText: (pending: readonly PendingProposal[]) => Promise<ReadonlyMap<string, string>>;
  /** Stored text of the human message behind each cited evidence id. */
  readonly evidenceText: (pending: readonly PendingProposal[]) => Promise<ReadonlyMap<string, string>>;
  readonly decide: (pending: PendingProposal, request: DecisionRequest) => Promise<DecisionReply>;
  readonly timeZone: string;
  readonly now: () => Date;
};

export type ReviewServer = {
  /** Page URL with the session token; anything without it gets a 403. */
  readonly url: string;
  readonly stop: () => Promise<void>;
};

const MAX_BODY_BYTES = 64 * 1024;

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function sameToken(received: string | null, expected: string): boolean {
  if (received === null || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function csp(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const commonHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { ...commonHeaders, "content-type": "text/plain; charset=utf-8" } });
}

function json(status: number, reply: DecisionReply): Response {
  return Response.json(reply, { status, headers: commonHeaders });
}

/** Serves the review page on 127.0.0.1 with a random port and token; decisions run one at a time. */
export function serveReview(options: ReviewServerOptions): ReviewServer {
  const token = randomHex(24);
  let queue: Promise<void> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const page = async (): Promise<Response> => {
    const pending = await options.pending();
    const nonce = randomHex(16);
    const html = renderPage({
      cards: selectRound(pending.map((entry) => entry.proposal)),
      pendingTotal: pending.length,
      now: options.now(),
      timeZone: options.timeZone,
      bulletText: await options.bulletText(pending),
      evidenceText: await options.evidenceText(pending),
      nonce,
      client: { mode: "live", endpoint: `/decision?t=${token}` },
    });
    return new Response(html, {
      headers: { ...commonHeaders, "content-type": "text/html; charset=utf-8", "content-security-policy": csp(nonce) },
    });
  };

  const decision = async (request: Request, origin: string): Promise<Response> => {
    if (request.headers.get("origin") !== origin) return json(403, { ok: false, error: "origine refusée" });
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
      return json(415, { ok: false, error: "JSON attendu" });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: "corps trop gros" });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: "JSON invalide" });
    }
    return serially(async () => {
      const pending = await options.pending();
      const byFingerprint = new Map(pending.map((entry) => [entry.proposal.fingerprint, entry]));
      const checked = checkRequest(body, byFingerprint);
      if (!checked.ok) return json(400, { ok: false, error: checked.error });
      const reply = await options.decide(checked.target, checked.request);
      return json(reply.ok ? 200 : 409, reply);
    });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, self): Promise<Response> => {
      const url = new URL(request.url);
      const host = `127.0.0.1:${self.port}`;
      if (request.headers.get("host") !== host) return text(421, "Hôte refusé.");
      if (!sameToken(url.searchParams.get("t"), token)) return text(403, "Jeton invalide.");
      try {
        if (request.method === "GET" && url.pathname === "/") return await page();
        if (request.method === "POST" && url.pathname === "/decision") return await decision(request, `http://${host}`);
        return text(404, "Introuvable.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`hindsight review: ${request.method} ${url.pathname} failed: ${message}`);
        return url.pathname === "/decision" ? json(500, { ok: false, error: message }) : text(500, message);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/?t=${token}`,
    stop: () => server.stop(true),
  };
}
