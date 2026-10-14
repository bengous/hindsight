/**
 * Builds the README demo's sandbox in the directory given as argument: the `atelier` checkout, hindsight's state and
 * config under XDG dirs of its own, five synthetic past sessions debriefed through the CLI, then one real Learn run.
 * Usage: bun docs/demo/sandbox.ts <dir>
 */
import { Schema } from "effect";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Step =
  | { readonly human: string }
  | { readonly say: string }
  | {
      readonly tool: "Bash" | "Edit" | "Write";
      readonly input: Readonly<Record<string, string>>;
      readonly output: string;
    };

type Files = Readonly<Record<string, string>>;

type Env = Readonly<Record<string, string>>;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type Steer = { readonly quote: string; readonly lesson: string };

type PastSession = {
  readonly daysAgo: number;
  readonly time: string;
  readonly steps: readonly Step[];
  readonly steers: readonly Steer[];
};

const MARKER = ".hindsight-demo";

const EXPECTED_PROPOSALS = 2;

const REPO = resolve(import.meta.dir, "../..");

const AGENTS_MD = `# atelier

Booking widgets for a pottery workshop: a calendar of sessions, a pricing table and a booking form, in TypeScript.

## Layout

- \`src/widgets/\` holds one file per widget.
- \`src/format.ts\` holds the date and price helpers.
- \`.claude/rules/typescript.md\` holds the style rules for the source.

## Conventions

- Keep widgets free of global state: everything comes in through their arguments.
- Format dates and prices at display time only, through \`src/format.ts\`.
- Run the \`test\` script before a commit.
`;

const TYPESCRIPT_RULES = `---
paths:
  - "src/**/*.ts"
---

- Type the parameters and the return value of every exported function.
- Validate form input with a zod schema declared next to its widget.
- Keep a widget under 200 lines; move shared helpers to \`src/format.ts\`.
`;

const ATELIER_FILES = {
  "AGENTS.md": AGENTS_MD,
  "CLAUDE.md": "@AGENTS.md\n",
  ".claude/rules/typescript.md": TYPESCRIPT_RULES,
  ".gitignore": "node_modules/\ndist/\n",
  "package.json": `${JSON.stringify(
    {
      name: "atelier",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { build: "tsc -p tsconfig.json", test: "node --test" },
      dependencies: { clsx: "^2.1.1", zod: "^3.23.8" },
    },
    null,
    2,
  )}\n`,
  "biome.json": `${JSON.stringify(
    { linter: { enabled: true, rules: { recommended: true, style: { noDefaultExport: "error" } } } },
    null,
    2,
  )}\n`,
  "tsconfig.json": `${JSON.stringify(
    { compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, outDir: "dist" }, include: ["src"] },
    null,
    2,
  )}\n`,
  "src/format.ts": `export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

export function formatPrice(cents: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
}
`,
  "src/widgets/calendar.ts": `import { formatDate } from "../format.js";

export type Session = { readonly startsAt: string; readonly seatsLeft: number };

export function renderCalendar(sessions: readonly Session[]): string {
  return sessions.map((session) => \`\${formatDate(session.startsAt)} · \${session.seatsLeft} places\`).join("\\n");
}
`,
  "src/widgets/pricing.ts": `import clsx from "clsx";

import { formatPrice } from "../format.js";

export function renderPricing(cents: number, isMember: boolean): string {
  return \`<span class="\${clsx("price", isMember && "price--member")}">\${formatPrice(cents)}</span>\`;
}
`,
  "src/widgets/booking.ts": `import { z } from "zod";

export const BookingForm = z.object({ name: z.string().min(1), email: z.string().email(), seats: z.number().int().min(1) });

export function parseBooking(input: FormData): z.infer<typeof BookingForm> {
  return BookingForm.parse({ name: input.get("name"), email: input.get("email"), seats: Number(input.get("seats")) });
}
`,
} satisfies Files;

const NPM_ADDED = (name: string): string =>
  `\nadded 1 package, and audited 3 packages in 1s\n\n1 package is looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities\n\n(${name})`;

const PNPM_ADDED = (name: string, version: string): string =>
  `Packages: +1\n+\nProgress: resolved 3, reused 2, downloaded 1, added 1, done\n\ndependencies:\n+ ${name} ${version}\n\nDone in 1.1s`;

function pastSessions(atelier: string): readonly PastSession[] {
  const file = (path: string): string => join(atelier, path);

  return [
    {
      daysAgo: 9,
      time: "09:12:04",
      steps: [
        { human: "ajoute zod pour valider le formulaire de réservation" },
        { tool: "Bash", input: { command: "npm install zod", description: "Install zod" }, output: NPM_ADDED("zod") },
        { say: "zod est installé ; je branche le schéma dans le formulaire." },
        { human: "non, on est sur pnpm ici, pas npm. refais l'install avec pnpm" },
        {
          tool: "Bash",
          input: { command: "rm -f package-lock.json && pnpm add zod", description: "Reinstall zod with pnpm" },
          output: PNPM_ADDED("zod", "3.23.8"),
        },
        { say: "Refait avec pnpm : package-lock.json supprimé, zod ajouté." },
      ],
      steers: [
        { quote: "on est sur pnpm ici, pas npm", lesson: "Use pnpm for every package command in atelier; never npm." },
      ],
    },
    {
      daysAgo: 7,
      time: "14:40:31",
      steps: [
        { human: "crée le widget du calendrier des ateliers" },
        {
          tool: "Write",
          input: {
            file_path: file("src/widgets/calendar.ts"),
            content: "export default function renderCalendar(sessions: readonly Session[]): string {",
          },
          output: `File created successfully at: ${file("src/widgets/calendar.ts")}`,
        },
        { say: "Le widget est dans src/widgets/calendar.ts." },
        { human: "pas d'export default, des exports nommés comme le reste du dépôt" },
        {
          tool: "Edit",
          input: {
            file_path: file("src/widgets/calendar.ts"),
            old_string: "export default function renderCalendar",
            new_string: "export function renderCalendar",
          },
          output: `The file ${file("src/widgets/calendar.ts")} has been updated successfully.`,
        },
        { say: "Corrigé : renderCalendar est un export nommé." },
      ],
      steers: [
        {
          quote: "pas d'export default, des exports nommés comme le reste du dépôt",
          lesson: "Use named exports in atelier; never export default.",
        },
      ],
    },
    {
      daysAgo: 6,
      time: "08:05:47",
      steps: [
        { human: "ajoute clsx pour composer les classes du widget de tarifs" },
        { tool: "Bash", input: { command: "npm i clsx", description: "Install clsx" }, output: NPM_ADDED("clsx") },
        { human: "encore npm ? c'est pnpm dans ce dépôt" },
        {
          tool: "Bash",
          input: { command: "rm -f package-lock.json && pnpm add clsx", description: "Install clsx with pnpm" },
          output: PNPM_ADDED("clsx", "2.1.1"),
        },
        {
          tool: "Write",
          input: {
            file_path: file("src/widgets/pricing.ts"),
            content: "export default function renderPricing(cents: number, isMember: boolean): string {",
          },
          output: `File created successfully at: ${file("src/widgets/pricing.ts")}`,
        },
        { human: "et remets un export nommé, pas de default" },
        {
          tool: "Edit",
          input: {
            file_path: file("src/widgets/pricing.ts"),
            old_string: "export default function renderPricing",
            new_string: "export function renderPricing",
          },
          output: `The file ${file("src/widgets/pricing.ts")} has been updated successfully.`,
        },
        { say: "clsx ajouté avec pnpm, renderPricing exporté par son nom." },
      ],
      steers: [
        { quote: "c'est pnpm dans ce dépôt", lesson: "Run package commands with pnpm in this repository, not npm." },
        {
          quote: "remets un export nommé, pas de default",
          lesson: "Export widgets as named exports, not default exports.",
        },
      ],
    },
    {
      daysAgo: 4,
      time: "16:20:12",
      steps: [
        { human: "mets à jour zod" },
        {
          tool: "Bash",
          input: { command: "npm update zod", description: "Update zod" },
          output: "\nchanged 1 package, and audited 3 packages in 1s\n\nfound 0 vulnerabilities",
        },
        { human: "non, pnpm update zod. pas de npm dans atelier" },
        {
          tool: "Bash",
          input: { command: "rm -f package-lock.json && pnpm update zod", description: "Update zod with pnpm" },
          output: "Progress: resolved 3, reused 3, downloaded 0, added 0, done\n\nDone in 0.8s",
        },
        { say: "zod est à jour, via pnpm." },
      ],
      steers: [{ quote: "pas de npm dans atelier", lesson: "Use pnpm, never npm, for dependency changes in atelier." }],
    },
    {
      daysAgo: 2,
      time: "10:30:58",
      steps: [
        { human: "ajoute le formulaire de réservation avec son schéma zod" },
        {
          tool: "Bash",
          input: { command: "npm install", description: "Install dependencies" },
          output: NPM_ADDED("zod"),
        },
        {
          tool: "Write",
          input: {
            file_path: file("src/widgets/booking.ts"),
            content: "export default function parseBooking(input: FormData): z.infer<typeof BookingForm> {",
          },
          output: `File created successfully at: ${file("src/widgets/booking.ts")}`,
        },
        { say: "Le formulaire et son schéma sont dans src/widgets/booking.ts." },
        { human: "deux choses : pnpm, pas npm, et pas d'export default" },
        {
          tool: "Edit",
          input: {
            file_path: file("src/widgets/booking.ts"),
            old_string: "export default function parseBooking",
            new_string: "export function parseBooking",
          },
          output: `The file ${file("src/widgets/booking.ts")} has been updated successfully.`,
        },
        { say: "parseBooking est un export nommé ; les prochaines installations passent par pnpm." },
      ],
      steers: [
        { quote: "pnpm, pas npm", lesson: "Install dependencies with pnpm in atelier, never npm." },
        { quote: "pas d'export default", lesson: "Use named exports only; never export default." },
      ],
    },
  ];
}

function run(command: readonly string[], cwd: string, env: Env, stdin = ""): string {
  const result = Bun.spawnSync([...command], {
    cwd,
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

/** One CLI command; its answer is the last stdout line, as the mod reads it. */
function hindsight(env: Env, args: readonly string[], stdin = ""): string {
  const out = run(["bun", join(REPO, "src/cli/main.ts"), ...args], REPO, env, stdin).trim();

  return out.split("\n").at(-1) ?? "";
}

const decodeStarted = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ id: Schema.String })));

const decodeRecorded = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      failure: Schema.NullOr(Schema.String),
      notes: Schema.Struct({ steers: Schema.Number }),
    }),
  ),
);

const decodeStatus = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ pendingProposals: Schema.Number })));

function prepareDir(dir: string): string {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    if (!existsSync(join(dir, MARKER))) {
      throw new Error(`${dir} is not empty and holds no ${MARKER}: refusing to replace it`);
    }

    rmSync(dir, { recursive: true, force: true });
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARKER), "Built by docs/demo/sandbox.ts; the script may delete this directory.\n");

  return realpathSync(dir);
}

function writeTree(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function initAtelier(atelier: string, hooks: string, env: Env): void {
  mkdirSync(hooks, { recursive: true });
  writeTree(atelier, ATELIER_FILES);
  const git = (...args: string[]): string => run(["git", ...args], atelier, env);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Atelier Dev");
  git("config", "user.email", "dev@atelier.example");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", hooks);
  git("add", "-A");
  git("commit", "-q", "-m", "Start the atelier booking widgets");
}

function isoAt(daysAgo: number, time: string): string {
  const day = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

  return `${day}T${time}.000Z`;
}

function entry(base: Readonly<Record<string, string>>, at: Date, fields: Readonly<Record<string, Json>>): string {
  return JSON.stringify({ ...base, uuid: crypto.randomUUID(), timestamp: at.toISOString(), ...fields });
}

/** A transcript in Claude Code's JSONL shape: the loaded Rule Files, then each typed message, tool call and reply. */
function transcript(session: PastSession, sessionId: string, atelier: string): string {
  const base = { sessionId, cwd: atelier, entrypoint: "cli", version: "2.1.299", gitBranch: "main" };
  let at = new Date(isoAt(session.daysAgo, session.time));

  const tick = (seconds: number): Date => {
    at = new Date(at.getTime() + seconds * 1000);

    return at;
  };

  const lines = [
    entry(base, at, {
      type: "attachment",
      attachment: {
        type: "instructions",
        files: [
          { path: join(atelier, "CLAUDE.md"), type: "Project", content: "@AGENTS.md\n" },
          { path: join(atelier, "AGENTS.md"), type: "Project", content: AGENTS_MD },
        ],
      },
    }),
  ];

  for (const [index, step] of session.steps.entries()) {
    if ("human" in step) {
      lines.push(
        entry(base, tick(40), {
          type: "user",
          origin: { kind: "human" },
          promptSource: "typed",
          message: { role: "user", content: step.human },
        }),
      );
    } else if ("say" in step) {
      lines.push(
        entry(base, tick(6), {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: step.say }] },
        }),
      );
    } else {
      const id = `toolu_${sessionId.slice(0, 8)}${index}`;
      lines.push(
        entry(base, tick(5), {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "tool_use", id, name: step.tool, input: step.input }] },
        }),
        entry(base, tick(3), {
          type: "user",
          toolUseResult: { stdout: step.output },
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: step.output }] },
        }),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** What the Debrief fork answers, in the format `debriefPrompt` asks for. */
function forkAnswer(session: PastSession): string {
  const steers = session.steers.map((steer) => ({ ...steer, habit: true }));

  return `\`\`\`json\n${JSON.stringify({ steers, observations: [], staleRules: [] }, null, 2)}\n\`\`\``;
}

function shellQuote(value: string): string {
  if (value.includes("'")) {
    throw new Error(`cannot single-quote ${value}`);
  }

  return `'${value}'`;
}

function writeExecutable(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function main(): void {
  const target = process.argv[2];

  if (target === undefined || target === "") {
    throw new Error("usage: bun docs/demo/sandbox.ts <dir>");
  }

  const realHome = process.env["HOME"] ?? "";
  const realClaude = Bun.which("claude");

  if (realHome === "" || realClaude === null) {
    throw new Error("HOME and a claude binary on PATH are required");
  }

  const root = prepareDir(resolve(target));
  const atelier = join(root, "atelier");
  const projects = join(root, "projects");
  const cache = join(root, "cache");
  const toolsBin = join(root, "tools", "node_modules", ".bin");

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
  );

  const demoEnv = {
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm-store"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    DISABLE_AUTOUPDATER: "1",
  };

  const seedEnv = {
    ...inherited,
    ...demoEnv,
    PATH: `${toolsBin}:${inherited["PATH"] ?? ""}`,
    HINDSIGHT_PROJECTS_DIR: projects,
    HINDSIGHT_NO_LEARN: "1",
  } satisfies Env;

  writeTree(join(root, "config"), {
    "hindsight/config.json": `${JSON.stringify({ gate: { dailyCap: 1000 }, learn: { pendingNotes: 1000 } }, null, 2)}\n`,
  });
  initAtelier(atelier, join(root, "git-hooks"), seedEnv);
  run(["npm", "install", "--prefix", join(root, "tools"), "--no-audit", "--no-fund", "pnpm@10"], root, seedEnv);

  const slug = atelier.replaceAll(/[^a-zA-Z0-9]/g, "-");

  for (const session of pastSessions(atelier)) {
    const sessionId = crypto.randomUUID();
    writeTree(join(projects, slug), { [`${sessionId}.jsonl`]: transcript(session, sessionId, atelier) });

    const { id } = decodeStarted(hindsight(seedEnv, ["debrief", "start", "--session", sessionId, "--repo", atelier]));

    const body = {
      sessionId,
      cacheShare: 0.96,
      durationMs: 11_000,
      text: forkAnswer(session),
      repoRoot: atelier,
    };

    const recorded = decodeRecorded(hindsight(seedEnv, ["debrief", "record", "--id", id], JSON.stringify(body)));

    if (recorded.status !== "recorded" || recorded.notes.steers !== session.steers.length) {
      throw new Error(`debrief of ${sessionId}: ${JSON.stringify(recorded)}`);
    }
  }

  // Learn reads the global Rule Files under HOME: an empty HOME keeps the user's own out of the prompt, while
  // the wrapper gives `claude -p` (run with --safe-mode) the real HOME, where its login lives.
  const learnBin = join(root, "learn-bin");
  writeExecutable(
    join(learnBin, "claude"),
    `#!/bin/sh\nHOME=${shellQuote(realHome)} exec ${shellQuote(realClaude)} "$@"\n`,
  );
  mkdirSync(join(root, "home"), { recursive: true });
  const learnEnv = { ...seedEnv, HOME: join(root, "home"), PATH: `${learnBin}:${seedEnv.PATH}` } satisfies Env;
  process.stdout.write(`learn: ${hindsight(learnEnv, ["learn"])}\n`);

  const status = hindsight(seedEnv, ["status"]);
  process.stdout.write(`status: ${status}\n`);

  writeTree(root, {
    "claude-settings.json": `${JSON.stringify(
      {
        permissions: {
          allow: [
            "Bash(npm:*)",
            "Bash(pnpm:*)",
            "Bash(cat:*)",
            "Bash(ls:*)",
            "Bash(grep:*)",
            "Bash(git status:*)",
            "Bash(git diff:*)",
            "Bash(rm -f package-lock.json:*)",
            "Bash(rm package-lock.json:*)",
            "Bash(rm -rf node_modules:*)",
            "Bash(rm -rf package-lock.json:*)",
            "Bash(git checkout:*)",
            "Bash(git restore:*)",
          ],
          defaultMode: "default",
        },
        disableAgentView: true,
        disableRemoteControl: true,
        promptSuggestionEnabled: false,
        spinnerTipsEnabled: false,
      },
      null,
      2,
    )}\n`,
    "env.sh": [
      ...Object.entries(demoEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `export PATH=${shellQuote(toolsBin)}:"$PATH"`,
      "",
    ].join("\n"),
  });
  writeExecutable(
    join(root, "claude-demo"),
    `#!/bin/sh\n. ${shellQuote(join(root, "env.sh"))}\ncd ${shellQuote(atelier)} || exit 1\nexec claude --plugin-dir ${shellQuote(REPO)} --setting-sources project,local --strict-mcp-config --no-chrome --settings ${shellQuote(join(root, "claude-settings.json"))} "$@"\n`,
  );

  if (decodeStatus(status).pendingProposals !== EXPECTED_PROPOSALS) {
    throw new Error(`expected ${EXPECTED_PROPOSALS} pending Proposals; see the learn and status lines above`);
  }

  process.stdout.write(`ready: ${root}\n  source ${join(root, "env.sh")}\n  ${join(root, "claude-demo")}\n`);
}

main();
