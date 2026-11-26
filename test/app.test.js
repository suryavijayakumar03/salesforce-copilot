const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createApp, readConfig, normalizeEmail } = require("../server");
const { UsageStore } = require("../lib/usage-store");

function makeClient({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (args) => {
        calls.push(args);
        if (fail) throw new Error("boom");
        return { content: [{ type: "text", text: "Here is your answer." }] };
      },
    },
  };
}

async function start(overrides = {}, clientOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-"));
  const config = {
    ...readConfig({}),
    paidCode: "correct-horse-battery",
    dataDir,
    ...overrides,
  };
  const client = makeClient(clientOptions);
  const app = createApp({ client, config });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body, ip = "9.9.9.9") => {
    const res = await fetch(base + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { base, post, client, dataDir, close: () => server.close() };
}

test("rejects a missing or oversized question", async () => {
  const t = await start({ maxQuestionChars: 50 });
  assert.equal((await t.post("/api/ask", { mode: "free", email: "a@b.co" })).status, 400);
  assert.equal(
    (await t.post("/api/ask", { question: "x".repeat(51), mode: "free", email: "a@b.co" })).status,
    400
  );
  assert.equal(t.client.calls.length, 0);
  t.close();
});

test("free sample needs a valid email", async () => {
  const t = await start();
  const r = await t.post("/api/ask", { question: "hi", mode: "free", email: "not-an-email" });
  assert.equal(r.status, 400);
  assert.equal(t.client.calls.length, 0);
  t.close();
});

test("free sample allows 3 questions, counts down, then stops without calling Claude", async () => {
  const t = await start();
  const ask = () => t.post("/api/ask", { question: "q", mode: "free", email: "Buyer@Example.com" });
  assert.equal((await ask()).body.freeRemaining, 2);
  assert.equal((await ask()).body.freeRemaining, 1);
  assert.equal((await ask()).body.freeRemaining, 0);
  const fourth = await ask();
  assert.equal(fourth.status, 403);
  assert.equal(fourth.body.code, "free_limit_reached");
  assert.ok(fourth.body.buyUrl.startsWith("https://"));
  assert.equal(t.client.calls.length, 3);
  t.close();
});

test("free answers are shorter than paid answers", async () => {
  const t = await start();
  await t.post("/api/ask", { question: "q", mode: "free", email: "a@b.co" });
  await t.post("/api/ask", { question: "q", mode: "paid", code: "correct-horse-battery" });
  assert.equal(t.client.calls[0].max_tokens, 900);
  assert.equal(t.client.calls[1].max_tokens, 2048);
  assert.match(t.client.calls[0].system, /free sample/);
  assert.doesNotMatch(t.client.calls[1].system, /free sample/);
  t.close();
});

test("email aliases share one free allowance", async () => {
  assert.equal(normalizeEmail("Jane.Doe+promo@Gmail.com"), "janedoe@gmail.com");
  assert.equal(normalizeEmail("jane.doe@googlemail.com"), "janedoe@gmail.com");
  assert.equal(normalizeEmail("a+x@company.com"), "a@company.com");
  assert.equal(normalizeEmail("bad"), null);
  assert.equal(normalizeEmail(42), null);

  const t = await start({ freePerEmail: 1 });
  const first = await t.post("/api/ask", { question: "q", mode: "free", email: "jane.doe@gmail.com" });
  const second = await t.post("/api/ask", { question: "q", mode: "free", email: "janedoe+2@gmail.com" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 403);
  t.close();
});

test("paid mode checks the password on the server", async () => {
  const t = await start();
  const bad = await t.post("/api/ask", { question: "q", mode: "paid", code: "wrong" });
  assert.equal(bad.status, 401);
  const none = await t.post("/api/ask", { question: "q", mode: "paid" });
  assert.equal(none.status, 401);
  const ok = await t.post("/api/ask", { question: "q", mode: "paid", code: "correct-horse-battery" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.answer, "Here is your answer.");
  assert.equal(t.client.calls.length, 1);
  t.close();
});

test("old hard-coded password no longer works and is not in the page", async () => {
  const t = await start();
  const r = await t.post("/api/ask", { question: "q", mode: "paid", code: "sfadmin2024" });
  assert.equal(r.status, 401);
  const html = await (await fetch(t.base + "/")).text();
  assert.ok(html.includes("Try the Copilot"));
  assert.ok(!html.includes("sfadmin2024"));
  assert.ok(!html.includes("correct-horse-battery"));
  t.close();
});

test("paid mode is disabled when no password is configured", async () => {
  const t = await start({ paidCode: "" });
  const r = await t.post("/api/ask", { question: "q", mode: "paid", code: "" });
  assert.equal(r.status, 503);
  const v = await t.post("/api/verify", { code: "anything" });
  assert.equal(v.status, 503);
  t.close();
});

test("verify endpoint accepts the right code and rejects others", async () => {
  const t = await start();
  assert.equal((await t.post("/api/verify", { code: "correct-horse-battery" })).status, 200);
  assert.equal((await t.post("/api/verify", { code: "nope" })).status, 401);
  assert.equal((await t.post("/api/verify", {})).status, 401);
  t.close();
});

test("repeated wrong passwords lock that network out for the day", async () => {
  const t = await start({ failedCodesPerIpPerDay: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await t.post("/api/verify", { code: "bad" + i }, "5.5.5.5")).status, 401);
  }
  // Even the right code is refused now from that network.
  assert.equal((await t.post("/api/verify", { code: "correct-horse-battery" }, "5.5.5.5")).status, 429);
  // A different network is unaffected.
  assert.equal((await t.post("/api/verify", { code: "correct-horse-battery" }, "6.6.6.6")).status, 200);
  t.close();
});

test("global daily limit stops all Claude calls", async () => {
  const t = await start({ globalDailyLimit: 2, paidPerIpPerDay: 100 });
  const ask = (ip) => t.post("/api/ask", { question: "q", mode: "paid", code: "correct-horse-battery" }, ip);
  assert.equal((await ask("1.1.1.1")).status, 200);
  assert.equal((await ask("2.2.2.2")).status, 200);
  const third = await ask("3.3.3.3");
  assert.equal(third.status, 503);
  assert.equal(third.body.code, "capacity");
  assert.equal(t.client.calls.length, 2);
  t.close();
});

test("free samples cannot use up the whole daily budget", async () => {
  const t = await start({ globalDailyLimit: 10, freeDailyLimit: 2, freePerIpPerDay: 100 });
  const free = (n) => t.post("/api/ask", { question: "q", mode: "free", email: `user${n}@x.co` });
  assert.equal((await free(1)).status, 200);
  assert.equal((await free(2)).status, 200);
  const third = await free(3);
  assert.equal(third.status, 503);
  assert.equal(third.body.code, "free_capacity");
  // Paying customers still get through.
  const paid = await t.post("/api/ask", { question: "q", mode: "paid", code: "correct-horse-battery" });
  assert.equal(paid.status, 200);
  t.close();
});

test("per-network limits apply to free and paid use", async () => {
  const t = await start({ freePerIpPerDay: 2, paidPerIpPerDay: 1 });
  const free = (n) => t.post("/api/ask", { question: "q", mode: "free", email: `p${n}@x.co` }, "7.7.7.7");
  assert.equal((await free(1)).status, 200);
  assert.equal((await free(2)).status, 200);
  assert.equal((await free(3)).status, 429);
  const paid = () => t.post("/api/ask", { question: "q", mode: "paid", code: "correct-horse-battery" }, "8.8.8.8");
  assert.equal((await paid()).status, 200);
  assert.equal((await paid()).status, 429);
  t.close();
});

test("a failed Claude call does not use up the visitor's allowance", async () => {
  const t = await start({ freePerEmail: 1 }, { fail: true });
  const r = await t.post("/api/ask", { question: "q", mode: "free", email: "a@b.co" });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "Failed to get answer. Please try again.");
  const dataFile = JSON.parse(fs.readFileSync(path.join(t.dataDir, "usage.json"), "utf8"));
  assert.equal(dataFile.global, 0);
  assert.equal(dataFile.emails["a@b.co"], 0);
  t.close();
});

test("usage survives a restart and each lead is logged once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-store-"));
  const limits = { ...readConfig({}), freePerEmail: 3 };
  const a = new UsageStore(dir);
  assert.equal(a.reserve({ kind: "free", email: "lead@x.co", ip: "1.1.1.1", limits }).ok, true);
  assert.equal(a.reserve({ kind: "free", email: "lead@x.co", ip: "1.1.1.1", limits }).ok, true);

  const b = new UsageStore(dir); // simulates a restart
  assert.equal(b.freeRemaining("lead@x.co", 3), 1);

  const leads = fs.readFileSync(path.join(dir, "leads.jsonl"), "utf8").trim().split("\n");
  assert.equal(leads.length, 1);
  assert.equal(JSON.parse(leads[0]).email, "lead@x.co");
});

test("answers are returned as plain text for the page to escape", async () => {
  const t = await start();
  const html = await (await fetch(t.base + "/")).text();
  assert.ok(html.includes("function esc("));
  assert.ok(html.includes("esc(text)"));
  t.close();
});
