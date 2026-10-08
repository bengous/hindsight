#!/usr/bin/env bun
import type { ModelAlias } from "./model/claude.ts";
import type { RunOptions, RunReport, ScanOptions, ScanReport } from "./pipeline.ts";
import { parseArgs } from "node:util";
import { displayPath } from "./curate/ids.ts";
import { run, scan } from "./pipeline.ts";
import { defaultStateRoot, listRunIds, pendingProposals, readRunSummary } from "./state/index.ts";

const usage = `hindsight <commande> [options]

  scan      passe déterministe seule : groupes d'erreurs, règles périmées, volumes (aucun appel modèle)
  run       passe complète : extraction, curation, propositions
  status    propositions en attente, dernier run, coût

Options communes (scan, run) :
  --days N            fenêtre de fréquence en jours (30)
  --repo PATH         ne garder que ce dépôt (répétable)
  --no-archive        ignorer archive/*.jsonl.zst|gz
  --json              sortie JSON brute

Options de run :
  --budget USD        plafond du run (10)
  --max-sessions N    nombre maximal de sessions à extraire hors cache
  --extract-model M   haiku | sonnet | opus (haiku)
  --curate-model M    haiku | sonnet | opus (opus)
  --concurrency N     appels d'extraction en parallèle (4)
  --seed PATH         ancienne note auto-memory à verser comme preuve (répétable)
  --seed-repo PATH    dépôt des notes --seed`;

const MODELS: readonly ModelAlias[] = ["haiku", "sonnet", "opus"];
const TOP = 8;

class UsageError extends Error {}

function positiveNumber(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${flag} attend un nombre positif, reçu "${raw}"`);
  return value;
}

function modelOf(flag: string, raw: string | undefined): ModelAlias | undefined {
  if (raw === undefined) return undefined;
  const model = MODELS.find((candidate) => candidate === raw);
  if (model === undefined) throw new UsageError(`${flag} attend ${MODELS.join(" | ")}, reçu "${raw}"`);
  return model;
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      days: { type: "string" },
      repo: { type: "string", multiple: true },
      "no-archive": { type: "boolean" },
      json: { type: "boolean" },
      budget: { type: "string" },
      "max-sessions": { type: "string" },
      "extract-model": { type: "string" },
      "curate-model": { type: "string" },
      concurrency: { type: "string" },
      seed: { type: "string", multiple: true },
      "seed-repo": { type: "string" },
    },
  }).values;
}

type Flags = ReturnType<typeof parse>;

function scanOptions(flags: Flags): ScanOptions {
  const lookbackDays = positiveNumber("--days", flags.days);
  return {
    ...(lookbackDays === undefined ? {} : { lookbackDays }),
    ...(flags.repo === undefined ? {} : { repos: flags.repo }),
    includeArchive: flags["no-archive"] !== true,
  };
}

function runOptions(flags: Flags): RunOptions {
  const budgetUsd = positiveNumber("--budget", flags.budget);
  const maxSessions = positiveNumber("--max-sessions", flags["max-sessions"]);
  const concurrency = positiveNumber("--concurrency", flags.concurrency);
  const extractModel = modelOf("--extract-model", flags["extract-model"]);
  const curateModel = modelOf("--curate-model", flags["curate-model"]);
  if (flags.seed !== undefined && flags["seed-repo"] === undefined) {
    throw new UsageError("--seed exige --seed-repo");
  }
  return {
    ...scanOptions(flags),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(maxSessions === undefined ? {} : { maxSessions }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(extractModel === undefined ? {} : { extract: { model: extractModel } }),
    ...(curateModel === undefined ? {} : { curate: { model: curateModel } }),
    ...(flags.seed === undefined ? {} : { seeds: flags.seed }),
    ...(flags["seed-repo"] === undefined ? {} : { seedRepo: flags["seed-repo"] }),
  };
}

const repoLabel = (repoRoot: string | null): string =>
  repoRoot === null ? "(sans checkout)" : displayPath(repoRoot, null);

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function printScan(report: ScanReport): void {
  const { totals, byRepo, stats } = report.volumes;
  console.log(`hindsight scan · depuis ${report.since.slice(0, 10)}`);
  console.log(
    `${totals.sessions} sessions · ${totals.humanMessages} messages humains · ${totals.errorEvents} erreurs d'outil`,
  );
  console.log(
    `écartées : ${stats.droppedSessions.sdk} sessions claude -p, ${stats.droppedSessions.scratch} de scratchpad, ${stats.duplicateEntries} doublons`,
  );
  console.log(`\nPar dépôt (${Math.min(TOP, byRepo.length)} premiers) :`);
  for (const repo of byRepo.slice(0, TOP)) {
    console.log(
      `  ${repoLabel(repo.repoRoot).padEnd(40)} ${String(repo.sessions).padStart(4)} sessions ${String(repo.humanMessages).padStart(5)} messages ${String(repo.errorEvents).padStart(5)} erreurs`,
    );
  }
  if (report.missingCheckouts.length > 0) {
    console.log(
      `\nDépôts sans checkout (propositions écartées) : ${report.missingCheckouts.map(repoLabel).join(", ")}`,
    );
  }
  console.log(`\nFichiers de règles inventoriés : ${report.ruleFiles}`);
  console.log(`\nGroupes d'erreurs récurrents : ${report.clusters.length}`);
  for (const cluster of report.clusters.slice(0, TOP)) {
    console.log(
      `  ${String(cluster.sessions).padStart(3)} sessions · ${String(cluster.days).padStart(2)} jours  ${oneLine(cluster.signature, 70)}`,
    );
  }
  console.log(`\nRègles périmées : ${report.stale.length}`);
  for (const finding of report.stale) {
    console.log(
      `  ${displayPath(finding.sourcePath, finding.repoRoot)} · ${finding.reason} · ${oneLine(finding.detail, 80)}`,
    );
  }
}

function printRun(report: RunReport): void {
  const s = report.sessions;
  console.log(`hindsight run ${report.runId} · ${report.status}`);
  console.log(
    `sessions : ${s.collected} lues, ${s.withHumanText} avec texte humain, ${s.extracted} extraites, ${s.cached} en cache, ${s.failed} en échec, ${s.notRun} non traitées`,
  );
  console.log(`${report.items} éléments · ${report.groups} groupes · ${report.proposals} propositions`);
  const dropped = Object.entries(report.dropped).toSorted((a, b) => b[1] - a[1]);
  if (dropped.length > 0) {
    console.log(`écartés : ${dropped.map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
  }
  console.log(
    `coût : ${report.usage.costUsd.toFixed(3)} $ sur ${report.budgetUsd} $ (${report.usage.calls} appels, ${report.usage.inputTokens} tokens en entrée, ${report.usage.outputTokens} en sortie)`,
  );
  for (const failure of report.failures) {
    console.log(`échec ${failure.stage} ${failure.key} · ${failure.kind} · ${oneLine(failure.message, 120)}`);
  }
  console.log(`état : ${report.stateDir}`);
}

async function printStatus(json: boolean): Promise<void> {
  const root = defaultStateRoot();
  const pending = await pendingProposals(root);
  const runIds = await listRunIds(root);
  const lastId = runIds.at(-1);
  const last = lastId === undefined ? null : await readRunSummary(root, lastId);
  if (json) {
    console.log(JSON.stringify({ pending: pending.length, lastRun: last }, null, 2));
    return;
  }
  console.log(`propositions en attente : ${pending.length}`);
  if (last === null) {
    console.log("aucun run");
    return;
  }
  console.log(
    `dernier run : ${last.runId} · ${last.status} · ${last.finishedAt ?? "en cours"} · ${last.usage.costUsd.toFixed(3)} $`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      console.log(usage);
      return 0;
    case "scan": {
      const flags = parse(rest);
      const report = await scan(scanOptions(flags));
      if (flags.json === true) console.log(JSON.stringify(report, null, 2));
      else printScan(report);
      return 0;
    }
    case "run": {
      const flags = parse(rest);
      const report = await run(runOptions(flags));
      if (flags.json === true) console.log(JSON.stringify(report, null, 2));
      else printRun(report);
      return report.status === "complete" ? 0 : 1;
    }
    case "status":
      await printStatus(parse(rest).json === true);
      return 0;
    default:
      throw new UsageError(`commande inconnue "${command}"`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError || (error instanceof TypeError && "code" in error)) {
    console.error(`hindsight: ${error.message}\n\n${usage}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
