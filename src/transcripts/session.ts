import type { JsonRecord } from "./json.ts";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { cleanHumanText, slashCommand } from "../domain/human.ts";
import { contentText, isRecord, recordField, recordsField, stringField } from "./json.ts";
import { forEachEntry } from "./read.ts";

export type LoadedRuleSource = "instructions" | "nested_memory" | "output_style";

export type LoadedRule = {
  readonly path: string;
  readonly source: LoadedRuleSource;
  readonly content: string | null;
};

export type HumanEvent = {
  readonly kind: "human";
  readonly uuid: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly text: string;
};

export type ToolEvent = {
  readonly kind: "tool";
  /** The assistant entry that holds the tool_use block: the evidence id names it. */
  readonly uuid: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly tool: string;
  readonly input: JsonRecord;
  readonly inputText: string;
  readonly outputText: string;
  readonly isError: boolean;
  readonly isRefused: boolean;
};

export type InterruptEvent = { readonly kind: "interrupt"; readonly timestamp: string };

export type SessionEvent = HumanEvent | ToolEvent | InterruptEvent;

export type SessionRecord = {
  readonly sessionId: string;
  readonly chain: readonly string[];
  readonly cwd: string | null;
  readonly isInteractive: boolean;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly events: readonly SessionEvent[];
  readonly loadedRules: readonly LoadedRule[];
};

const INTERRUPT_PREFIX = "[Request interrupted by user";

const PATH_INPUTS: Readonly<Record<string, string>> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

export function humanEvents(record: SessionRecord): readonly HumanEvent[] {
  return record.events.filter((event): event is HumanEvent => event.kind === "human");
}

export function toolEvents(record: SessionRecord): readonly ToolEvent[] {
  return record.events.filter((event): event is ToolEvent => event.kind === "tool");
}

/** The text an Edit or Write put in its file, or null for another tool. */
export function editedText(event: ToolEvent): string | null {
  if (event.tool === "Edit") {
    return stringField(event.input, "new_string");
  }

  if (event.tool === "Write") {
    return stringField(event.input, "content");
  }

  return null;
}

export function editedPath(event: ToolEvent): string | null {
  const key = PATH_INPUTS[event.tool];

  return key === undefined ? null : stringField(event.input, key);
}

export function absolutePath(path: string, cwd: string | null, home: string = homedir()): string {
  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }

  if (isAbsolute(path) || cwd === null) {
    return path;
  }

  return resolve(cwd, path);
}

type Classified =
  | { readonly kind: "typed"; readonly text: string }
  | { readonly kind: "interrupt" }
  | { readonly kind: "other" };

/** Which user entries are the human's own words: the prototype's rules, kept as the oracle. */
export function classifyUserEntry(entry: JsonRecord): Classified {
  if (entry["toolUseResult"] !== undefined) {
    return { kind: "other" };
  }

  if (entry["isMeta"] === true || entry["isCompactSummary"] === true || entry["isVisibleInTranscriptOnly"] === true) {
    return { kind: "other" };
  }

  if (stringField(entry, "entrypoint") === "sdk-cli" || stringField(entry, "promptSource") === "sdk") {
    return { kind: "other" };
  }

  const message = recordField(entry, "message");
  const raw = message === null ? "" : contentText(message["content"]);

  if (raw.trimStart().startsWith(INTERRUPT_PREFIX)) {
    return { kind: "interrupt" };
  }

  const origin = recordField(entry, "origin");

  if (origin === null || stringField(origin, "kind") !== "human") {
    return { kind: "other" };
  }

  const text = cleanHumanText(raw);
  const command = slashCommand(text);

  if (command !== null) {
    return command.args === "" ? { kind: "other" } : { kind: "typed", text: command.args };
  }

  return text === "" ? { kind: "other" } : { kind: "typed", text };
}

type Scan = {
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly sdk: boolean;
  readonly continuedIn: string | null;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly events: readonly SessionEvent[];
  readonly loadedRules: readonly LoadedRule[];
};

type PendingTool = {
  readonly uuid: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly tool: string;
  readonly input: JsonRecord;
};

function required(entry: JsonRecord, key: string, path: string): string {
  const value = stringField(entry, key);

  if (value === null) {
    throw new Error(`${path}: ${stringField(entry, "type")} entry without "${key}"`);
  }

  return value;
}

export function resolveOutputStylePath(name: string, styleDirs: readonly string[]): string {
  const file = styleDirs.map((dir) => join(dir, `${name}.md`)).find((candidate) => existsSync(candidate));

  return file ?? `output-style:${name}`;
}

async function scanFile(path: string, home: string): Promise<Scan> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let sdk = false;
  let continuedIn: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const events: SessionEvent[] = [];
  const pending = new Map<string, PendingTool>();
  const loadedRules = new Map<string, LoadedRule>();

  const load = (rule: LoadedRule): void => {
    loadedRules.set(`${rule.source}\0${rule.path}\0${rule.content ?? ""}`, rule);
  };

  const onAssistant = (entry: JsonRecord): void => {
    const message = recordField(entry, "message");

    for (const block of message === null ? [] : recordsField(message, "content")) {
      if (stringField(block, "type") !== "tool_use") {
        continue;
      }

      const id = stringField(block, "id");
      const name = stringField(block, "name");

      if (id === null || name === null) {
        continue;
      }

      pending.set(id, {
        uuid: required(entry, "uuid", path),
        sessionId: required(entry, "sessionId", path),
        timestamp: required(entry, "timestamp", path),
        tool: name,
        input: recordField(block, "input") ?? {},
      });
    }
  };

  const onToolResult = (entry: JsonRecord, block: JsonRecord): void => {
    const toolUseId = stringField(block, "tool_use_id");
    const call = toolUseId === null ? null : (pending.get(toolUseId) ?? null);

    if (call === null || toolUseId === null) {
      return;
    }

    pending.delete(toolUseId);
    const denial = stringField(entry, "toolDenialKind");
    const isError = block["is_error"] === true;
    events.push({
      kind: "tool",
      uuid: call.uuid,
      sessionId: call.sessionId,
      timestamp: call.timestamp,
      tool: call.tool,
      input: call.input,
      inputText: JSON.stringify(call.input),
      outputText: contentText(block["content"]),
      isError,
      isRefused: denial === "user-rejected",
    });
  };

  const onUser = (entry: JsonRecord): void => {
    const message = recordField(entry, "message");

    const results = (message === null ? [] : recordsField(message, "content")).filter(
      (block) => stringField(block, "type") === "tool_result",
    );

    if (results.length > 0) {
      for (const result of results) {
        onToolResult(entry, result);
      }

      return;
    }

    const classified = classifyUserEntry(entry);

    if (classified.kind === "interrupt") {
      events.push({ kind: "interrupt", timestamp: required(entry, "timestamp", path) });
    } else if (classified.kind === "typed") {
      events.push({
        kind: "human",
        uuid: required(entry, "uuid", path),
        sessionId: required(entry, "sessionId", path),
        timestamp: required(entry, "timestamp", path),
        text: classified.text,
      });
    }
  };

  const onAttachment = (entry: JsonRecord): void => {
    const attachment = recordField(entry, "attachment");

    if (attachment === null) {
      return;
    }

    switch (stringField(attachment, "type")) {
      case "instructions": {
        for (const file of recordsField(attachment, "files")) {
          const filePath = stringField(file, "path");

          if (filePath !== null) {
            load({ path: filePath, source: "instructions", content: stringField(file, "content") });
          }
        }

        return;
      }

      case "nested_memory": {
        const filePath = stringField(attachment, "path");
        const content = attachment["content"];
        const text = typeof content === "string" ? content : isRecord(content) ? stringField(content, "content") : null;

        if (filePath !== null) {
          load({ path: filePath, source: "nested_memory", content: text });
        }

        return;
      }

      case "output_style_instructions": {
        const style = recordField(attachment, "style");
        const name = style === null ? null : stringField(style, "name");

        if (style === null || name === null) {
          return;
        }

        const entryCwd = stringField(entry, "cwd") ?? cwd;

        const styleDirs = [
          ...(entryCwd === null ? [] : [join(entryCwd, ".claude", "output-styles")]),
          join(home, ".claude", "output-styles"),
        ];

        load({
          path: resolveOutputStylePath(name, styleDirs),
          source: "output_style",
          content: stringField(style, "prompt"),
        });

        return;
      }

      default: {
        return;
      }
    }
  };

  await forEachEntry(path, (entry) => {
    const type = stringField(entry, "type");
    const timestamp = stringField(entry, "timestamp");

    if (timestamp !== null) {
      if (firstAt === null || timestamp < firstAt) {
        firstAt = timestamp;
      }

      if (lastAt === null || timestamp > lastAt) {
        lastAt = timestamp;
      }
    }

    if (stringField(entry, "entrypoint") === "sdk-cli") {
      sdk = true;
    }

    sessionId ??= stringField(entry, "sessionId");

    if (cwd === null && (type === "user" || type === "assistant")) {
      cwd = stringField(entry, "cwd");
    }

    switch (type) {
      case "assistant": {
        onAssistant(entry);

        return;
      }

      case "user": {
        onUser(entry);

        return;
      }

      case "attachment": {
        onAttachment(entry);

        return;
      }

      case "continued-in": {
        continuedIn = stringField(entry, "continuedInSessionId") ?? continuedIn;

        return;
      }

      default: {
        return;
      }
    }
  });

  return { sessionId, cwd, sdk, continuedIn, firstAt, lastAt, events, loadedRules: [...loadedRules.values()] };
}

/** `<projectsDir>/<project>/<sessionId>.jsonl`, or null when no project holds it. */
export async function findSessionFile(projectsDir: string, sessionId: string): Promise<string | null> {
  if (!existsSync(projectsDir)) {
    return null;
  }

  for await (const relative of new Bun.Glob(`*/${sessionId}.jsonl`).scan({ cwd: projectsDir, onlyFiles: true })) {
    return join(projectsDir, relative);
  }

  return null;
}

const CONTINUED_IN = /"continuedInSessionId"\s*:\s*"([^"]+)"/;

/** Which session each file of the project continues into, read without parsing whole files. */
async function continuations(projectDir: string): Promise<ReadonlyMap<string, string>> {
  const links = new Map<string, string>();

  for await (const relative of new Bun.Glob("*.jsonl").scan({ cwd: projectDir, onlyFiles: true })) {
    const text = await Bun.file(join(projectDir, relative)).text();

    if (!text.includes("continuedInSessionId")) {
      continue;
    }

    const target = CONTINUED_IN.exec(text)?.[1];

    if (target !== undefined) {
      links.set(relative.slice(0, -".jsonl".length), target);
    }
  }

  return links;
}

async function predecessors(projectDir: string, sessionId: string, seen: Set<string>): Promise<readonly string[]> {
  const links = await continuations(projectDir);
  const chain: string[] = [];
  let target = sessionId;

  for (;;) {
    const found = [...links].find(([from, to]) => to === target && !seen.has(from))?.[0];

    if (found === undefined) {
      return chain.reverse();
    }

    seen.add(found);
    chain.push(found);
    target = found;
  }
}

/** The session and the files it continues, oldest first, merged into one record. */
export async function readSession(
  projectsDir: string,
  sessionId: string,
  home: string = homedir(),
): Promise<SessionRecord | null> {
  const file = await findSessionFile(projectsDir, sessionId);

  if (file === null) {
    return null;
  }

  const projectDir = join(file, "..");
  const seen = new Set([sessionId]);
  const chain = [...(await predecessors(projectDir, sessionId, seen)), sessionId];
  const scans: Scan[] = [];

  for (const id of chain) {
    scans.push(await scanFile(join(projectDir, `${id}.jsonl`), home));
  }

  const rules = new Map<string, LoadedRule>();

  for (const rule of scans.flatMap((scan) => scan.loadedRules)) {
    rules.set(`${rule.source}\0${rule.path}`, rule);
  }

  const instants = scans
    .flatMap((scan) => [scan.firstAt, scan.lastAt])
    .filter((at): at is string => at !== null)
    .sort();

  return {
    sessionId,
    chain,
    cwd: scans.find((scan) => scan.cwd !== null)?.cwd ?? null,
    isInteractive: !scans.some((scan) => scan.sdk),
    firstAt: instants[0] ?? null,
    lastAt: instants.at(-1) ?? null,
    events: scans.flatMap((scan) => scan.events),
    loadedRules: [...rules.values()],
  };
}

export async function scanSessionFile(path: string, home: string = homedir()): Promise<SessionRecord | null> {
  const scan = await scanFile(path, home);

  if (scan.sessionId === null) {
    return null;
  }

  return {
    sessionId: scan.sessionId,
    chain: [scan.sessionId],
    cwd: scan.cwd,
    isInteractive: !scan.sdk,
    firstAt: scan.firstAt,
    lastAt: scan.lastAt,
    events: scan.events,
    loadedRules: scan.loadedRules,
  };
}
