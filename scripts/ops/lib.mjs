// Shared plumbing for the operations scripts in this folder: where credentials live, the
// Cloudflare API and database access. Nothing in here ever prints a secret value.

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const srcDir = path.join(repoRoot, "src");

// Credentials and the deploy snapshot live outside the repository. PSN_BOT_HOME moves the folder.
export const homeDir = process.env.PSN_BOT_HOME || path.join(os.homedir(), ".psn-bot");

export const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

// ---------------------------------------------------------------------------------------
// Credentials.

// KEY=value lines; blank lines and # comments are ignored and matching quotes are removed.
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) values[match[1]] = value;
  }
  return values;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

// The token and account ID come from the environment, else from ~/.psn-bot/credentials.env.
export function loadCredentials({ env = process.env, file = path.join(homeDir, "credentials.env") } = {}) {
  const stored = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const apiToken = env.CLOUDFLARE_API_TOKEN || stored.CLOUDFLARE_API_TOKEN || "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || stored.CLOUDFLARE_ACCOUNT_ID || "";

  if (!apiToken) throw new Error(`CLOUDFLARE_API_TOKEN is not set (environment or ${file})`);
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error(`CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID, not the account name (environment or ${file})`);
  }
  return { apiToken, accountId };
}

// ---------------------------------------------------------------------------------------
// wrangler.toml: the one place that names the Worker, its schedule and its database.

export function parseWranglerConfig(text) {
  // Split into the top-level keys and one chunk per [section] / [[section]].
  const [head, ...sections] = String(text).split(/^(?=\[)/m);
  const strings = (body) =>
    Object.fromEntries([...String(body).matchAll(/^[ \t]*([A-Za-z_][\w-]*)[ \t]*=[ \t]*"([^"\n]*)"/gm)].map((match) => [match[1], match[2]]));
  const section = (name) => sections.find((body) => new RegExp(`^\\[+${name}\\]+`).test(body)) ?? "";

  const top = strings(head);
  const d1 = strings(section("d1_databases"));
  const cronList = /^[ \t]*crons[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(section("triggers"))?.[1] ?? "";

  return {
    name: top.name,
    main: top.main,
    compatibilityDate: top.compatibility_date,
    vars: strings(section("vars")),
    crons: [...cronList.matchAll(/"([^"]*)"/g)].map((match) => match[1]),
    observability: /^[ \t]*enabled[ \t]*=[ \t]*true\b/m.test(section("observability")),
    d1: { binding: d1.binding ?? "DB", databaseName: d1.database_name, databaseId: d1.database_id },
  };
}

export function readWranglerConfig(file = path.join(repoRoot, "wrangler.toml")) {
  const config = parseWranglerConfig(readFileSync(file, "utf8"));
  const required = [
    ["name", config.name],
    ["main", config.main],
    ["compatibility_date", config.compatibilityDate],
    ["d1_databases database_id", config.d1.databaseId],
  ];
  for (const [label, value] of required) {
    if (!value) throw new Error(`wrangler.toml has no ${label}`);
  }
  return config;
}

// ---------------------------------------------------------------------------------------
// Read-only guard for inspecting the live database.

// Blanks out string literals, quoted names and comments, so only the SQL's own words are left.
export function stripSqlNoise(sql) {
  const text = String(sql);
  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] !== ch) break;
          j += 1; // doubled quote inside the literal
        }
        j += 1;
      }
      out += `${ch}${ch}`;
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const WRITING = /\b(?:insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b|\breplace\s+into\b|\bor\s+replace\b/i;

// One SELECT (or WITH ... SELECT) statement that can't change anything. Returns the SQL.
export function assertReadOnly(sql) {
  const text = stripSqlNoise(sql).trim();
  if (!/^(?:select|with)\b/i.test(text)) throw new Error("only SELECT queries are allowed here");
  if (/;\s*\S/.test(text)) throw new Error("only a single statement is allowed here");
  if (WRITING.test(text)) throw new Error("only read-only queries are allowed here");
  return sql;
}

// ---------------------------------------------------------------------------------------
// Cloudflare.

function describeErrors(body) {
  const errors = (body?.errors || []).map((error) => `${error.code} ${error.message}`).join("; ");
  return errors || "no details";
}

// A client for the bot's Worker and database. Methods:
//   request(path, init)  -> { status, ok, body }, never throws on an HTTP error
//   api(path, init)      -> the response's `result`, throws with Cloudflare's error text
//   query(sql, params)   -> { results, meta } for any statement (writes included)
//   select(sql, params)  -> rows, for read-only statements only
//   explain(sql, params) -> the query plan; compiles the statement without running it
//   graphql(query, vars) -> Cloudflare's analytics API
export function connect({ credentials = loadCredentials(), config = readWranglerConfig() } = {}) {
  const { apiToken, accountId } = credentials;

  async function request(pathname, init = {}) {
    const headers = { Authorization: `Bearer ${apiToken}`, ...init.headers };
    if (typeof init.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API}${pathname}`, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: Boolean(body.success), body };
  }

  async function api(pathname, init = {}) {
    const { status, ok, body } = await request(pathname, init);
    if (!ok) throw new Error(`${init.method || "GET"} ${pathname} failed (${status}): ${describeErrors(body)}`);
    return body.result;
  }

  const account = (suffix = "") => `/accounts/${accountId}${suffix}`;
  const script = (suffix = "") => account(`/workers/scripts/${config.name}${suffix}`);
  const databasePath = account(`/d1/database/${config.d1.databaseId}/query`);

  async function query(sql, params = []) {
    const result = await api(databasePath, { method: "POST", body: JSON.stringify({ sql, params }) });
    return { results: result?.[0]?.results ?? [], meta: result?.[0]?.meta ?? {} };
  }

  async function graphql(text, variables) {
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: text, variables }),
    });
    return res.json().catch(() => ({}));
  }

  return {
    accountId,
    config,
    request,
    api,
    account,
    script,
    query,
    select: async (sql, params = []) => (await query(assertReadOnly(sql), params)).results,
    explain: async (sql, params = []) => (await query(`EXPLAIN ${sql}`, params)).results,
    graphql,
  };
}

// ---------------------------------------------------------------------------------------
// A throwaway in-memory database with the same methods as connect(), built from schema.sql.
// Used by the tests and by `--local` options, so scripts can be tried without touching anything.

export async function createLocalBackend({ schemaFile = path.join(repoRoot, "schema.sql") } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaFile, "utf8"));

  const values = (params) => params.map((value) => (typeof value === "boolean" ? Number(value) : value));
  const returnsRows = (sql) =>
    /^\s*explain\b/i.test(sql) || (/^\s*(?:select|with)\b/i.test(sql) && !/\b(?:insert|update|delete)\b/i.test(sql));

  async function query(sql, params = []) {
    const statement = db.prepare(sql);
    if (returnsRows(sql)) return { results: statement.all(...values(params)).map((row) => ({ ...row })), meta: {} };
    return { results: [], meta: { changes: Number(statement.run(...values(params)).changes) } };
  }

  return {
    db,
    query,
    select: async (sql, params = []) => (await query(assertReadOnly(sql), params)).results,
    explain: async (sql, params = []) => (await query(`EXPLAIN ${sql}`, params)).results,
  };
}

// ---------------------------------------------------------------------------------------
// Running a script.

// True when the file is being run directly (not imported, e.g. by the tests).
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const normalize = (file) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));
  return normalize(fileURLToPath(metaUrl)) === normalize(process.argv[1]);
}

// Runs `main` only when the file is run directly; a failure prints one line and sets the exit code.
// (process.exit is avoided on purpose: on Windows it can crash while connections are closing.)
export function runCli(metaUrl, main) {
  if (!isMain(metaUrl)) return;
  Promise.resolve()
    .then(main)
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
    });
}
