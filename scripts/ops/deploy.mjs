// Deploys src/ to the live Worker through the Cloudflare API: no Wrangler, no npm install.
// Needs Node 22.13+ and a Cloudflare API token (see "Operating the live bot" in the README).
//
//   node scripts/ops/deploy.mjs deploy [--dry-run] [--var NAME=value ...] [--allow-remove]
//   node scripts/ops/deploy.mjs verify      bindings, schedule, latest deployment and health
//   node scripts/ops/deploy.mjs rollback    go back to the version saved before the last deploy
//   node scripts/ops/deploy.mjs snapshot    save the live version now (deploy does this itself)
//   node scripts/ops/deploy.mjs schedules   re-apply the cron schedule from wrangler.toml
//
// Every step also takes --snapshot <file> (default: deploy-snapshot.json next to the credentials).
//
// What a deploy sends: the modules in src/, the D1 binding and compatibility date from
// wrangler.toml, and the plain-text variables: the live ones, then [vars] from wrangler.toml,
// then --var. Secrets (the bot token, NPSSO codes) are never read or sent: `keep_bindings`
// leaves them exactly as they are. `--dry-run` builds the upload and shows what would change
// without sending it.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { connect, homeDir, runCli, srcDir } from "./lib.mjs";

const REQUIRED_BINDINGS = ["DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "PSN_NPSSO"];
const SECRET_NAME = /TOKEN|NPSSO|SECRET|PASSWORD/i;

// ---------------------------------------------------------------------------------------
// What gets uploaded.

// Every module in src/, uploaded as-is (the Worker has no bundling step, so no subfolders).
export function collectModules(dir = srcDir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const folder = entries.find((entry) => entry.isDirectory());
  if (folder) throw new Error(`src/${folder.name}/ is a folder; modules are uploaded flat, so keep them directly in src/`);
  return entries
    .filter((entry) => entry.name.endsWith(".js"))
    .map((entry) => ({ name: entry.name, source: readFileSync(path.join(dir, entry.name), "utf8") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const SPECIFIER =
  /\b(?:import|export)\b[^;"']*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// Imports the upload can't satisfy: anything but another module sitting next to it.
export function moduleImportProblems(modules) {
  const names = new Set(modules.map((module) => module.name));
  const problems = [];
  for (const { name, source } of modules) {
    for (const match of withoutComments(source).matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = specifier.startsWith("./") ? specifier.slice(2) : null;
      if (!target || target.includes("/")) {
        problems.push(`${name} imports "${specifier}", which can't be uploaded (only ./module.js files next to it can)`);
      } else if (!names.has(target)) {
        problems.push(`${name} imports "${specifier}", but src/${target} doesn't exist`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// Variables and bindings.

export function parseVarArgs(args) {
  const vars = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--var") continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(args[i + 1] ?? "");
    if (!match) throw new Error(`--var needs NAME=value, got "${args[i + 1] ?? ""}"`);
    vars[match[1]] = match[2];
    i += 1;
  }
  return vars;
}

// Variables are plain text, visible in the dashboard. Secrets are set in the dashboard or with
// `wrangler secret put`, never through a deploy.
export function assertPlainVar(name) {
  if (SECRET_NAME.test(name)) throw new Error(`${name} looks like a secret; set it in the Cloudflare dashboard or with "wrangler secret put", not as a variable`);
}

// Later sources win: live dashboard values, then wrangler.toml [vars], then --var.
export function mergePlainText(live, configVars, cliVars) {
  return { ...live, ...configVars, ...cliVars };
}

export function buildDeployMetadata({ config, plainText }) {
  if (!plainText.DISCORD_PUBLIC_KEY) {
    throw new Error("DISCORD_PUBLIC_KEY is in neither the live variables nor wrangler.toml; refusing to deploy without it");
  }
  return {
    main_module: path.basename(config.main),
    compatibility_date: config.compatibilityDate,
    bindings: [
      { type: "d1", name: config.d1.binding, id: config.d1.databaseId },
      ...Object.entries(plainText)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, text]) => ({ type: "plain_text", name, text })),
    ],
    keep_bindings: ["secret_text"],
    observability: { enabled: config.observability },
  };
}

// What a deploy would do to the live bindings. Secrets are kept, so they never show up here.
export function diffBindings(wanted, live) {
  const current = new Map(live.map((binding) => [binding.name, binding]));
  const changes = [];

  for (const binding of wanted) {
    const existing = current.get(binding.name);
    if (!existing) {
      changes.push({ change: "add", name: binding.name, type: binding.type });
    } else if (
      existing.type !== binding.type ||
      (binding.type === "plain_text" && existing.text !== binding.text) ||
      (binding.type === "d1" && (existing.id ?? existing.database_id) !== binding.id)
    ) {
      changes.push({ change: "change", name: binding.name, type: binding.type });
    }
  }

  const wantedNames = new Set(wanted.map((binding) => binding.name));
  for (const binding of live) {
    if (!wantedNames.has(binding.name) && binding.type !== "secret_text") {
      changes.push({ change: "remove", name: binding.name, type: binding.type });
    }
  }
  return changes;
}

function describeBinding(binding) {
  const short = (value) => (String(value).length > 8 ? `${String(value).slice(0, 8)}…` : String(value));
  if (binding.type === "plain_text") return `${binding.name} (variable ${short(binding.text)})`;
  if (binding.type === "d1") return `${binding.name} (d1 ${short(binding.id ?? binding.database_id ?? "")})`;
  return `${binding.name} (${binding.type})`;
}

// ---------------------------------------------------------------------------------------
// Steps.

function snapshotPath(args) {
  const at = args.indexOf("--snapshot");
  if (at === -1) return path.join(homeDir, "deploy-snapshot.json");
  if (!args[at + 1]) throw new Error("--snapshot needs a file name");
  return path.resolve(args[at + 1]);
}

async function readLive(cf) {
  const [settings, deployments] = await Promise.all([cf.api(cf.script("/settings")), cf.api(cf.script("/deployments"))]);
  return { settings, latest: deployments.deployments?.[0] };
}

function saveSnapshot(file, { settings, latest }) {
  const bindings = settings.bindings || [];
  const data = {
    takenAt: new Date().toISOString(),
    deploymentId: latest?.id,
    versions: latest?.versions,
    bindings: bindings.map(({ name, type }) => ({ name, type })),
    plainText: bindings.filter((binding) => binding.type === "plain_text").map(({ name, text }) => ({ name, text })),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

async function snapshot(cf, args) {
  const file = snapshotPath(args);
  const live = await readLive(cf);
  saveSnapshot(file, live);
  console.log(`Live deployment ${live.latest?.id} (${live.latest?.created_on}) versions ${JSON.stringify(live.latest?.versions)}`);
  console.log(`Bindings: ${(live.settings.bindings || []).map(describeBinding).join(", ")}`);
  console.log(`Saved to ${file}`);
}

async function deploy(cf, args) {
  const dryRun = args.includes("--dry-run");
  const cliVars = parseVarArgs(args);
  Object.keys(cliVars).forEach(assertPlainVar);

  const modules = collectModules();
  const problems = moduleImportProblems(modules);
  if (problems.length > 0) throw new Error(`the modules can't be uploaded as they are:\n  ${problems.join("\n  ")}`);
  const mainModule = path.basename(cf.config.main);
  if (!modules.some((module) => module.name === mainModule)) throw new Error(`${cf.config.main} (the main module) is missing`);

  const live = await readLive(cf);
  const liveBindings = live.settings.bindings || [];
  const livePlain = Object.fromEntries(liveBindings.filter((binding) => binding.type === "plain_text").map((binding) => [binding.name, binding.text]));
  const metadata = buildDeployMetadata({ config: cf.config, plainText: mergePlainText(livePlain, cf.config.vars, cliVars) });

  const changes = diffBindings(metadata.bindings, liveBindings);
  const removals = changes.filter((change) => change.change === "remove");
  if (removals.length > 0 && !args.includes("--allow-remove")) {
    throw new Error(`this deploy would remove ${removals.map((change) => `${change.name} (${change.type})`).join(", ")}; add them to this script or pass --allow-remove`);
  }

  console.log(`Modules: ${modules.length} (${modules.map((module) => module.name).join(", ")})`);
  console.log(`Bindings: ${changes.length === 0 ? "no changes" : changes.map((change) => `${change.change} ${change.name}`).join(", ")}; secrets are kept as they are`);

  // The schedule is separate from the code and survives deploys; only say something if it differs.
  const liveCrons = await cf
    .api(cf.script("/schedules"))
    .then((result) => (result.schedules || []).map((schedule) => schedule.cron))
    .catch(() => null);
  if (liveCrons && JSON.stringify([...liveCrons].sort()) !== JSON.stringify([...cf.config.crons].sort())) {
    console.log(`Schedule: live is ${liveCrons.join(", ") || "none"} but wrangler.toml says ${cf.config.crons.join(", ")}; run the schedules step to apply it`);
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const { name, source } of modules) form.append(name, new Blob([source], { type: "application/javascript+module" }), name);

  if (dryRun) {
    console.log("Dry run: built the upload, sent nothing.");
    return;
  }

  const file = snapshotPath(args);
  saveSnapshot(file, live);
  console.log(`Saved the current version (${live.latest?.id}) to ${file}, for rollback`);

  const result = await cf.api(cf.script(), { method: "PUT", body: form });
  console.log(`Uploaded. New script etag ${result.etag || "?"}, modified ${result.modified_on}`);
  console.log("Next: node scripts/ops/deploy.mjs verify");
}

async function schedules(cf) {
  const result = await cf.api(cf.script("/schedules"), { method: "PUT", body: JSON.stringify(cf.config.crons.map((cron) => ({ cron }))) });
  console.log(`Cron schedules now: ${(result.schedules || []).map((schedule) => schedule.cron).join(", ")}`);
}

async function verify(cf) {
  const settings = await cf.api(cf.script("/settings"));
  const bindings = settings.bindings || [];
  const present = new Set(bindings.map((binding) => binding.name));
  const missing = [cf.config.d1.binding, ...REQUIRED_BINDINGS].filter((name) => !present.has(name));
  let problems = missing.length;
  console.log(`Bindings: ${bindings.map(describeBinding).join(", ")}`);
  console.log(`Missing bindings: ${missing.join(", ") || "none"}`);
  console.log(`Observability: ${JSON.stringify(settings.observability ?? null)}`);

  const live = await cf.api(cf.script("/schedules"));
  const crons = (live.schedules || []).map((schedule) => schedule.cron);
  const sameCrons = JSON.stringify([...crons].sort()) === JSON.stringify([...cf.config.crons].sort());
  if (!sameCrons) problems += 1;
  console.log(`Cron schedules: ${crons.join(", ") || "none"}${sameCrons ? "" : ` (wrangler.toml says ${cf.config.crons.join(", ") || "none"})`}`);

  const { latest } = await readLive(cf);
  console.log(`Live deployment ${latest?.id} at ${latest?.created_on} (${latest?.source}) versions ${JSON.stringify(latest?.versions)}`);

  const subdomain = await cf.api(cf.account("/workers/subdomain")).catch(() => null);
  const enabled = await cf.api(cf.script("/subdomain")).catch(() => null);
  if (subdomain?.subdomain && enabled?.enabled !== false) {
    const url = `https://${cf.config.name}.${subdomain.subdomain}.workers.dev`;
    const health = await fetch(url)
      .then(async (res) => ({ status: res.status, text: (await res.text()).slice(0, 200) }))
      .catch((err) => ({ status: 0, text: err.message }));
    const unsigned = await fetch(url, {
      method: "POST",
      headers: { "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": "1" },
      body: JSON.stringify({ type: 1 }),
    })
      .then((res) => res.status)
      .catch(() => 0);
    if (health.status !== 200) problems += 1;
    if (unsigned !== 401) problems += 1;
    console.log(`Health ${url}: ${health.status} ${health.text}`);
    console.log(`Request without a Discord signature: ${unsigned}${unsigned === 401 ? " (rejected, as it should be)" : " (expected 401)"}`);
  } else {
    console.log("The workers.dev address is off, so the HTTP health check was skipped");
  }

  console.log(problems === 0 ? "OK" : `${problems} problem(s) found`);
  if (problems > 0) process.exitCode = 1;
}

async function rollback(cf, args) {
  const file = snapshotPath(args);
  if (!existsSync(file)) throw new Error(`no saved version at ${file}; deploy (or snapshot) first`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  if (!saved.versions?.length) throw new Error("the saved snapshot has no version to go back to");
  const result = await cf.api(cf.script("/deployments"), { method: "POST", body: JSON.stringify({ strategy: "percentage", versions: saved.versions }) });
  console.log(`Rolled back to ${JSON.stringify(saved.versions)}: deployment ${result.id}`);
  console.log("Next: node scripts/ops/deploy.mjs verify");
}

const STEPS = { deploy, verify, rollback, snapshot, schedules };

export async function main(args) {
  const [step, ...rest] = args;
  if (!STEPS[step]) {
    console.error(`Usage: node scripts/ops/deploy.mjs ${Object.keys(STEPS).join(" | ")}`);
    process.exitCode = 1;
    return;
  }
  await STEPS[step](connect(), rest);
}

runCli(import.meta.url, () => main(process.argv.slice(2)));
