import { getSettings, WEEKLY_POST_DAY, WEEKLY_POST_HOUR_UTC, DAY_MS } from "./config.js";

// Every D1 query and fetch() counts against Cloudflare's per-invocation subrequest cap.
// The budget lets code stop *before* the platform does, keeping a reserve so the final
// Discord reply can always be sent.
export class BudgetExceededError extends Error {
  constructor(kind) {
    super(`Subrequest budget exhausted (${kind})`);
    this.name = "BudgetExceededError";
  }
}

export class Budget {
  constructor(limit, reserve = 4) {
    this.limit = limit;
    this.reserve = reserve;
    this.used = 0;
    this.d1 = 0;
    this.fetches = 0;
  }

  remaining() {
    return Math.max(0, this.limit - this.reserve - this.used);
  }

  take(kind, { reserved = false } = {}) {
    const ceiling = reserved ? this.limit : this.limit - this.reserve;

    if (this.used + 1 > ceiling) {
      throw new BudgetExceededError(kind);
    }

    this.used += 1;
    if (kind === "d1") this.d1 += 1;
    else this.fetches += 1;
  }
}

// Expected failures that should be shown to the user as-is.
export class UserError extends Error {
  constructor(title, body = "", { tone = "warning", suggestions = [] } = {}) {
    super(title);
    this.name = "UserError";
    this.title = title;
    this.body = body;
    this.tone = tone;
    this.suggestions = suggestions;
  }
}

// A Platinum command used in a server without Platinum (shown with a buy button when possible).
export class PremiumRequiredError extends UserError {
  constructor() {
    super("This is a Platinum feature", "Platinum isn't active in this server.", { tone: "info" });
    this.name = "PremiumRequiredError";
  }
}

function countingDb(db, budget) {
  const wrap = (stmt) => ({
    statement: stmt,
    bind: (...values) => wrap(stmt.bind(...values)),
    first: (column) => {
      budget.take("d1");
      return column === undefined ? stmt.first() : stmt.first(column);
    },
    all: () => {
      budget.take("d1");
      return stmt.all();
    },
    run: () => {
      budget.take("d1");
      return stmt.run();
    },
  });

  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    // A batch is one subrequest no matter how many statements it holds.
    batch: (statements, options) => {
      budget.take("d1", options);
      return db.batch(statements.map((s) => s.statement));
    },
  };
}

export function createContext(env, { budget, now = Date.now(), workBudgetMs = 20_000 } = {}) {
  const settings = getSettings(env);
  const activeBudget = budget || new Budget(settings.subrequestBudget);

  return {
    env,
    settings,
    budget: activeBudget,
    now,
    deadline: now + workBudgetMs,
    db: countingDb(env.DB, activeBudget),
    fetch: (url, init, options) => {
      activeBudget.take("fetch", options);
      return fetch(url, init);
    },
    timeLeft() {
      return this.deadline - Date.now();
    },
    memo: {},
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs fn over items with at most `limit` in flight (Workers allow 6 connections waiting
// on headers at once). Errors are returned per item instead of rejecting the whole run.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampInteger(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Most recent `day` (0 = Sunday) at `hour`:00 UTC at or before `now`.
export function weeklySlot(now, day, hour) {
  const date = new Date(now);
  const slot = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour);
  const daysBack = (date.getUTCDay() - day + 7) % 7;
  let start = slot - daysBack * DAY_MS;
  if (start > now) start -= 7 * DAY_MS;
  return start;
}

// Most recent Sunday 16:00 UTC at or before `now`.
export function weeklyPostSlot(now) {
  return weeklySlot(now, WEEKLY_POST_DAY, WEEKLY_POST_HOUR_UTC);
}

export function nextWeeklyPostSlot(now) {
  return weeklyPostSlot(now) + 7 * DAY_MS;
}

export function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
