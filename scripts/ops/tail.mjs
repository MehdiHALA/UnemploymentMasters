// Streams the live Worker's events, like `wrangler tail`, and prints one line per invocation:
// the trigger (cron or HTTP), its outcome and status, the bot's own log lines and any errors.
//
//   node scripts/ops/tail.mjs [seconds]      (default 300)

import { connect, runCli } from "./lib.mjs";

// One event from the tail, as the lines to print and whether it counts as an error.
export function describeEvent(data) {
  const event = data.event || {};
  const isCron = event.cron !== undefined || event.scheduledTime !== undefined;
  const time = new Date(data.eventTimestamp || Date.now()).toISOString().slice(11, 19);
  const trigger = isCron ? `cron ${event.cron}` : `${event.request?.method || "?"} ${new URL(event.request?.url || "https://x/").pathname}`;
  const status = event.response?.status ?? "";

  const logs = (data.logs || []).map((log) => {
    const text = (log.message || []).map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
    return `${log.level}: ${text.slice(0, 300)}`;
  });
  const exceptions = (data.exceptions || []).map((exception) => `EXCEPTION ${exception.name}: ${String(exception.message).slice(0, 300)}`);

  return {
    isCron,
    isError: data.outcome !== "ok" || exceptions.length > 0 || logs.some((line) => line.startsWith("error")),
    lines: [`[${time}] ${trigger} → ${data.outcome}${status ? ` ${status}` : ""}`, ...[...logs, ...exceptions].map((line) => `    ${line}`)],
  };
}

export async function main(args) {
  const seconds = Number(args[0] || 300);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`seconds must be a positive number, got "${args[0]}"`);

  const cf = connect();
  const { id, url } = await cf.api(cf.script("/tails"), { method: "POST", body: "{}" });
  const counts = { fetch: 0, scheduled: 0, errors: 0 };

  const ws = new WebSocket(url, "trace-v1");
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ filters: [], debug: false }));
    console.log(`tail open at ${new Date().toISOString()} for ${seconds}s`);
  });
  ws.addEventListener("message", async (message) => {
    let data;
    try {
      data = JSON.parse(typeof message.data === "string" ? message.data : await message.data.text());
    } catch {
      return;
    }
    const { isCron, isError, lines } = describeEvent(data);
    counts[isCron ? "scheduled" : "fetch"] += 1;
    if (isError) counts.errors += 1;
    for (const line of lines) console.log(line);
  });
  ws.addEventListener("close", () => console.log("tail closed"));

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  ws.close();
  await cf.request(cf.script(`/tails/${id}`), { method: "DELETE" }).catch(() => {});
  console.log(`summary: ${counts.fetch} HTTP invocations, ${counts.scheduled} cron runs, ${counts.errors} with errors`);

  // Don't wait for the socket to finish closing.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}

runCli(import.meta.url, () => main(process.argv.slice(2)));
