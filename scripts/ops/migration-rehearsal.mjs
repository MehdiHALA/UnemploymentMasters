// Rehearses the Worker's pending schema upgrade before it reaches the live database: copies the
// live database's structure into a throwaway local database, runs the Worker's own migration
// code on it, and checks that the result matches schema.sql. With nothing pending, it just
// checks the live structure against schema.sql.
//
//   node scripts/ops/migration-rehearsal.mjs
//
// Only the live structure and row counts are read (SELECT). The upgrade runs locally.

import { readFileSync } from "node:fs";
import path from "node:path";

import { ensureSchema, resetSchemaCacheForTests, SCHEMA_VERSION } from "../../src/db.js";
import { Budget, createContext } from "../../src/runtime.js";
import { FakeD1 } from "../../test/helpers/harness.mjs";
import { connect, repoRoot, runCli } from "./lib.mjs";

// Tables with their columns and indexes, in a form that two databases can be compared by.
export function structure(database) {
  const result = {};
  for (const { name } of database.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    result[name] = database
      .rows(`PRAGMA table_info(${name})`)
      .map(({ name: column, type, notnull, dflt_value, pk }) => `${column} ${type}${notnull ? " NOT NULL" : ""}${dflt_value !== null ? ` DEFAULT ${dflt_value}` : ""}${pk ? ` PK${pk}` : ""}`)
      .sort();
  }
  result.indexes = database
    .rows("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .map((row) => `${row.name} ${row.sql.replace(/\s+/g, " ").replace(/IF NOT EXISTS /, "")}`);
  return result;
}

// What differs between two structures, one line per difference.
export function describeDifferences(actual, expected) {
  const lines = [];
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if (JSON.stringify(actual[key] ?? null) !== JSON.stringify(expected[key] ?? null)) {
      lines.push(`${key}:\n    after the upgrade: ${JSON.stringify(actual[key] ?? null)}\n    schema.sql:        ${JSON.stringify(expected[key] ?? null)}`);
    }
  }
  return lines;
}

export async function main() {
  const cf = connect();

  const objects = await cf.select(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' ORDER BY type DESC, name"
  );
  const [version] = await cf.select("SELECT value FROM job_state WHERE key = 'schema_version'");
  const [counts] = await cf.select(
    `SELECT (SELECT COUNT(*) FROM psn_users) AS links, (SELECT COUNT(*) FROM psn_trophy_cache) AS accounts,
            (SELECT COUNT(*) FROM guild_settings) AS servers, (SELECT COUNT(*) FROM psn_title_snapshots) AS snapshots`
  );
  const live = Number(version?.value || 0);
  console.log(`Live schema v${live}: ${objects.filter((o) => o.type === "table").length} tables, ${objects.filter((o) => o.type === "index").length} indexes; the code expects v${SCHEMA_VERSION}`);
  console.log(`Live rows: ${JSON.stringify(counts)}`);

  // The live structure, copied into a local database, then upgraded by the Worker's own code.
  const clone = new FakeD1({ read: 0, write: 0 });
  for (const type of ["table", "index"]) {
    for (const object of objects.filter((o) => o.type === type)) clone.sqlite.exec(object.sql);
  }
  clone.sqlite.prepare("INSERT OR REPLACE INTO job_state (key, value, updated_at) VALUES ('schema_version', ?, 0)").run(String(live));

  resetSchemaCacheForTests();
  const started = Date.now();
  await ensureSchema(createContext({ DB: clone }, { budget: new Budget(1000, 0) }));
  const after = Number(clone.row("SELECT value FROM job_state WHERE key = 'schema_version'").value);
  console.log(
    live >= SCHEMA_VERSION
      ? `No upgrade pending (live v${live}, code v${SCHEMA_VERSION})`
      : `Upgrade v${live} -> v${after} ran locally in ${Date.now() - started} ms`
  );

  const expected = new FakeD1({ read: 0, write: 0 });
  expected.sqlite.exec(readFileSync(path.join(repoRoot, "schema.sql"), "utf8"));
  const differences = describeDifferences(structure(clone), structure(expected));

  if (differences.length === 0 && after === SCHEMA_VERSION) {
    console.log(live >= SCHEMA_VERSION ? "The live structure matches schema.sql exactly" : "The upgraded structure matches schema.sql exactly");
  } else {
    console.log(`Differences:\n  ${differences.join("\n  ") || `(schema version is ${after}, expected ${SCHEMA_VERSION})`}`);
    process.exitCode = 1;
  }
}

runCli(import.meta.url, () => main());
