const fs = require("fs");
const path = require("path");

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tracks how much the Copilot is used so one person (or one leaked password)
 * cannot run up the Anthropic bill. State lives in one small JSON file.
 *
 * Daily counters reset at 00:00 UTC. Per-email free-sample counts never reset.
 * If the folder is not persistent (for example Railway without a volume), the
 * counters start again after a redeploy, but the daily caps still apply.
 */
class UsageStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "usage.json");
    this.leadsFile = path.join(dataDir, "leads.jsonl");
    this.state = { emails: {}, day: today(), global: 0, free: 0, ips: {}, failures: {} };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
      console.error("Could not create data directory:", e.message);
    }
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = { ...this.state, ...parsed };
    } catch (e) {
      // First run or unreadable file: start fresh.
    }
    this._rollDay();
  }

  _rollDay() {
    const d = today();
    if (this.state.day !== d) {
      this.state.day = d;
      this.state.global = 0;
      this.state.free = 0;
      this.state.ips = {};
      this.state.failures = {};
    }
  }

  _save() {
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("Could not save usage data:", e.message);
    }
  }

  _ip(ip) {
    const key = String(ip || "unknown");
    if (!this.state.ips[key]) this.state.ips[key] = { free: 0, paid: 0 };
    return this.state.ips[key];
  }

  freeRemaining(email, perEmail) {
    return Math.max(0, perEmail - (this.state.emails[email] || 0));
  }

  failureCount(ip) {
    this._rollDay();
    return this.state.failures[String(ip || "unknown")] || 0;
  }

  recordFailure(ip) {
    this._rollDay();
    const key = String(ip || "unknown");
    this.state.failures[key] = (this.state.failures[key] || 0) + 1;
    this._save();
  }

  /**
   * Try to use one question. Returns { ok: true, ... } and counts it, or
   * { ok: false, status, code, message } without counting anything.
   * Call release() with the result if the Claude call then fails.
   */
  reserve({ kind, email, ip, limits }) {
    this._rollDay();
    const s = this.state;
    const ipUse = this._ip(ip);

    if (kind === "free") {
      if (this.freeRemaining(email, limits.freePerEmail) <= 0) {
        return {
          ok: false,
          status: 403,
          code: "free_limit_reached",
          message: `You have used your ${limits.freePerEmail} free questions.`,
        };
      }
      if (ipUse.free >= limits.freePerIpPerDay) {
        return {
          ok: false,
          status: 429,
          code: "ip_limit",
          message: "Too many free questions from this network today. Please try again tomorrow.",
        };
      }
      if (s.free >= limits.freeDailyLimit) {
        return {
          ok: false,
          status: 503,
          code: "free_capacity",
          message: "Today's free samples are all taken. Please try again tomorrow.",
        };
      }
    } else if (ipUse.paid >= limits.paidPerIpPerDay) {
      return {
        ok: false,
        status: 429,
        code: "ip_limit",
        message: "Daily question limit reached for this network. Please try again tomorrow.",
      };
    }

    if (s.global >= limits.globalDailyLimit) {
      return {
        ok: false,
        status: 503,
        code: "capacity",
        message: "The Copilot has reached its daily limit. Please try again tomorrow.",
      };
    }

    s.global += 1;
    if (kind === "free") {
      s.free += 1;
      ipUse.free += 1;
      const isNewEmail = s.emails[email] === undefined;
      s.emails[email] = (s.emails[email] || 0) + 1;
      if (isNewEmail) this._addLead(email);
    } else {
      ipUse.paid += 1;
    }
    this._save();
    return { ok: true, kind, email, ip: String(ip || "unknown"), day: s.day };
  }

  /** Give back a reserved question after a failed Claude call. */
  release(reservation) {
    if (!reservation || !reservation.ok) return;
    this._rollDay();
    const s = this.state;
    if (reservation.day !== s.day) return; // day rolled over; nothing to give back
    const ipUse = this._ip(reservation.ip);
    s.global = Math.max(0, s.global - 1);
    if (reservation.kind === "free") {
      s.free = Math.max(0, s.free - 1);
      ipUse.free = Math.max(0, ipUse.free - 1);
      s.emails[reservation.email] = Math.max(0, (s.emails[reservation.email] || 0) - 1);
    } else {
      ipUse.paid = Math.max(0, ipUse.paid - 1);
    }
    this._save();
  }

  _addLead(email) {
    const line = JSON.stringify({ email, at: new Date().toISOString() });
    console.log("LEAD", line);
    try {
      fs.appendFileSync(this.leadsFile, line + "\n");
    } catch (e) {
      console.error("Could not save lead:", e.message);
    }
  }
}

module.exports = { UsageStore };
