const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { UsageStore } = require("./lib/usage-store");

const SYSTEM_PROMPT = `You are an expert Salesforce Admin AI Copilot with 10+ years of experience.

You help Salesforce Admins with:
- Salesforce Flows (Screen Flows, Record-Triggered Flows, Scheduled Flows)
- Validation Rules (formula syntax, error messages)
- Apex code (triggers, classes, test classes)
- SOQL queries
- Reports and Dashboards
- Permissions and Security (Profiles, Permission Sets, OWD, Sharing Rules)
- Process Builder (and migrating to Flow)
- Custom Objects and Fields
- Integration tips (REST API, webhooks, Connected Apps)
- Error debugging and troubleshooting

Your responses should:
- Be clear, specific, and immediately usable
- Include complete code/formula when asked
- Explain WHY something works, not just HOW
- Mention any gotchas or common mistakes
- Be formatted with headers and code blocks for readability

Always give production-ready answers that a Salesforce Admin can implement right away.`;

const FREE_ADDENDUM = `

This is a free sample answer. Keep it concise (under about 350 words), put the most useful fix first, and do not ask follow-up questions.`;

function intFrom(env, key, fallback) {
  const n = parseInt(env[key], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readConfig(env = process.env) {
  return {
    model: env.CLAUDE_MODEL || "claude-sonnet-4-6",
    paidCode: env.PAID_ACCESS_CODE || "",
    freePerEmail: intFrom(env, "FREE_QUESTIONS_PER_EMAIL", 3),
    freePerIpPerDay: intFrom(env, "FREE_PER_IP_PER_DAY", 5),
    paidPerIpPerDay: intFrom(env, "PAID_PER_IP_PER_DAY", 30),
    freeDailyLimit: intFrom(env, "FREE_DAILY_LIMIT", 20),
    globalDailyLimit: intFrom(env, "GLOBAL_DAILY_LIMIT", 60),
    maxQuestionChars: intFrom(env, "MAX_QUESTION_CHARS", 2000),
    failedCodesPerIpPerDay: intFrom(env, "FAILED_CODES_PER_IP_PER_DAY", 15),
    dataDir: env.DATA_DIR || path.join(__dirname, "data"),
    leadsWebhookUrl: env.LEADS_WEBHOOK_URL || "",
    leadsWebhookSecret: env.LEADS_WEBHOOK_SECRET || "",
    buyUrl: env.BUY_URL || "https://suryaairevops.gumroad.com/l/sfcopilot",
  };
}

// Compare secrets without leaking length or position through timing.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Lowercase, drop "+tag", and fold Gmail dots so one person cannot
// get unlimited free samples from name+1@gmail.com, na.me@gmail.com, etc.
function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return null;
  let [local, domain] = value.split("@");
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

function createApp({ client, config = readConfig(), store }) {
  const usage = store || new UsageStore(config.dataDir, {
    leadsWebhookUrl: config.leadsWebhookUrl,
    leadsWebhookSecret: config.leadsWebhookSecret,
  });
  const app = express();
  app.set("trust proxy", 1); // Railway sits behind one proxy; req.ip is the real visitor
  app.use(express.json({ limit: "20kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Check a paid-access password on the server (never in the page).
  function checkPaidCode(req, res, code) {
    if (!config.paidCode) {
      res.status(503).json({ error: "Paid access is not configured yet." });
      return false;
    }
    if (usage.failureCount(req.ip) >= config.failedCodesPerIpPerDay) {
      res.status(429).json({ error: "Too many incorrect attempts. Please try again tomorrow." });
      return false;
    }
    if (typeof code !== "string" || !safeEqual(code, config.paidCode)) {
      usage.recordFailure(req.ip);
      res.status(401).json({ error: "Incorrect password. Please try again." });
      return false;
    }
    return true;
  }

  app.post("/api/verify", (req, res) => {
    const body = req.body || {};
    if (!checkPaidCode(req, res, body.code)) return;
    res.json({ ok: true });
  });

  app.post("/api/ask", async (req, res) => {
    const body = req.body || {};
    const question = typeof body.question === "string" ? body.question.trim() : "";

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }
    if (question.length > config.maxQuestionChars) {
      return res
        .status(400)
        .json({ error: `Question is too long (maximum ${config.maxQuestionChars} characters).` });
    }

    let kind;
    let email = null;
    if (body.mode === "paid") {
      if (!checkPaidCode(req, res, body.code)) return;
      kind = "paid";
    } else {
      email = normalizeEmail(body.email);
      if (!email) {
        return res.status(400).json({ error: "Enter a valid email address to use the free sample." });
      }
      kind = "free";
    }

    const reservation = usage.reserve({ kind, email, ip: req.ip, limits: config });
    if (!reservation.ok) {
      return res
        .status(reservation.status)
        .json({ error: reservation.message, code: reservation.code, buyUrl: config.buyUrl });
    }

    try {
      const message = await client.messages.create({
        model: config.model,
        max_tokens: kind === "free" ? 900 : 2048,
        system: kind === "free" ? SYSTEM_PROMPT + FREE_ADDENDUM : SYSTEM_PROMPT,
        messages: [{ role: "user", content: question }],
      });

      const answer = message.content && message.content[0] && message.content[0].text;
      if (!answer) throw new Error("Empty response from Claude");

      const payload = { answer };
      if (kind === "free") payload.freeRemaining = usage.freeRemaining(email, config.freePerEmail);
      res.json(payload);
    } catch (error) {
      usage.release(reservation);
      console.error("Claude API error:", error && error.message ? error.message : error);
      res.status(500).json({ error: "Failed to get answer. Please try again." });
    }
  });

  return app;
}

if (require.main === module) {
  require("dotenv").config();
  const Anthropic = require("@anthropic-ai/sdk");
  const config = readConfig();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("WARNING: ANTHROPIC_API_KEY is not set. Questions will fail.");
  }
  if (!config.paidCode) {
    console.warn(
      "WARNING: PAID_ACCESS_CODE is not set. Paid access is disabled until you set it; the free sample still works."
    );
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const app = createApp({ client, config });
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀 Salesforce Copilot running at http://localhost:${PORT}\n`);
  });
}

module.exports = { createApp, readConfig, normalizeEmail };
