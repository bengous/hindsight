import type { SQLQueryBindings } from "bun:sqlite";

import { Database } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { MIGRATIONS } from "./migrations.ts";
import { FILE_MODE, ensurePrivateDir } from "./paths.ts";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Row = Record<string, string | number | null>;

export type SyncStore = {
  readonly run: (sql: string, params?: readonly SQLQueryBindings[]) => number;
  readonly all: <T extends Row>(sql: string, params?: readonly SQLQueryBindings[]) => T[];
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the row the caller's SQL selects, as for `all`, which passes only because the rule counts `T[]` twice; bun:sqlite's `query<T>` takes it the same way.
  readonly get: <T extends Row>(sql: string, params?: readonly SQLQueryBindings[]) => T | null;
};

export class Store extends Context.Service<
  Store,
  {
    readonly path: string;
    readonly run: (sql: string, params?: readonly SQLQueryBindings[]) => Effect.Effect<number, StoreError>;
    readonly all: <T extends Row>(sql: string, params?: readonly SQLQueryBindings[]) => Effect.Effect<T[], StoreError>;
    readonly get: <T extends Row>(
      sql: string,
      params?: readonly SQLQueryBindings[],
    ) => Effect.Effect<T | null, StoreError>;
    /** Runs `body` inside one SQLite transaction; a throw rolls it back. */
    readonly transaction: <A>(body: (sync: SyncStore) => A) => Effect.Effect<A, StoreError>;
  }
>()("hindsight/store/db/Store") {}

export type StoreService = Store["Service"];

const UserVersionRow = Schema.Struct({ user_version: Schema.Number });

const BUSY_TIMEOUT_MS = 5000;

function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    ensurePrivateDir(dirname(path));
    const existed = existsSync(path);
    const db = new Database(path, { create: true, strict: true });

    if (!existed) {
      chmodSync(path, FILE_MODE);
    }

    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.run("PRAGMA journal_mode = WAL");

    return db;
  }

  return new Database(path, { strict: true });
}

function migrate(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  const version = Schema.decodeUnknownSync(UserVersionRow)(db.query("PRAGMA user_version").get()).user_version;

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    const sql = MIGRATIONS[index];

    if (sql === undefined) {
      continue;
    }

    db.transaction(() => {
      db.run(sql);
      db.run(`PRAGMA user_version = ${index + 1}`);
    })();
  }
}

function syncStore(db: Database): SyncStore {
  return {
    run: (sql, params = []) => db.query(sql).run(...params).changes,
    all: <T extends Row>(sql: string, params: readonly SQLQueryBindings[] = []) =>
      db.query<T, SQLQueryBindings[]>(sql).all(...params),
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- implements SyncStore.get: T is the row the caller's SQL selects, handed to bun:sqlite's `query<T>`.
    get: <T extends Row>(sql: string, params: readonly SQLQueryBindings[] = []) =>
      db.query<T, SQLQueryBindings[]>(sql).get(...params) ?? null,
  };
}

const wrap = <A>(operation: string, body: () => A): Effect.Effect<A, StoreError> =>
  Effect.try({ try: body, catch: (cause) => new StoreError({ operation, cause }) });

export function makeStore(path: string): Effect.Effect<StoreService, StoreError> {
  return Effect.try({
    try: () => {
      const db = openDatabase(path);
      migrate(db);
      const sync = syncStore(db);

      return {
        path,
        run: (sql, params) => wrap("run", () => sync.run(sql, params)),
        all: <T extends Row>(sql: string, params?: readonly SQLQueryBindings[]) =>
          wrap("all", () => sync.all<T>(sql, params)),
        get: <T extends Row>(sql: string, params?: readonly SQLQueryBindings[]) =>
          wrap("get", () => sync.get<T>(sql, params)),
        transaction: (body) => wrap("transaction", () => db.transaction(() => body(sync))()),
      } satisfies StoreService;
    },
    catch: (cause) => new StoreError({ operation: "open", cause }),
  });
}

export const storeLayer = (path: string): Layer.Layer<Store, StoreError> => Layer.effect(Store, makeStore(path));
