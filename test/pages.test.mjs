import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PRIVACY_HTML, TERMS_HTML } from "../src/pages.js";
import worker from "../src/worker.js";

test("terms.html and privacy.html match the pages the Worker serves", () => {
  assert.equal(readFileSync(new URL("../terms.html", import.meta.url), "utf8").replace(/\r\n/g, "\n"), TERMS_HTML);
  assert.equal(readFileSync(new URL("../privacy.html", import.meta.url), "utf8").replace(/\r\n/g, "\n"), PRIVACY_HTML);
});

test("the Worker serves the Terms of Service and Privacy Policy as web pages", async () => {
  for (const [path, title] of [
    ["/terms", "Terms of Service"],
    ["/privacy", "Privacy Policy"],
  ]) {
    const res = await worker.fetch(new Request(`https://bot.example${path}`), {}, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), new RegExp(`<h1>${title}</h1>`));
  }
  const health = await worker.fetch(new Request("https://bot.example/"), {}, { waitUntil() {} });
  assert.deepEqual(await health.json(), { ok: true, service: "psn-trophy-bot" });
});
