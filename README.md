# ⚡ Salesforce Admin AI Copilot

> An AI-powered assistant for Salesforce Admins — get instant, expert answers to Flows, SOQL, Apex, Validation Rules, Permissions, and more.

## 🚀 What It Does

Ask anything Salesforce-related and get expert-level answers powered by Claude AI:
- Write Flows, Validation Rules, SOQL queries
- Fix Apex trigger errors
- Understand Permission Sets vs Profiles
- And much more

Responds like a **senior Salesforce Admin with 10+ years of experience** — with working code, step-by-step setup instructions, common variations, and gotchas.

## 🛠️ Tech Stack

- **Frontend:** HTML, CSS, Vanilla JS
- **Backend:** Node.js + Express
- **AI:** Anthropic Claude API (claude-sonnet-4-6)

## 📦 Installation

**1. Clone the repo**
\`\`\`bash
git clone https://github.com/suryavijayakumar03/salesforce-copilot.git
cd salesforce-copilot
\`\`\`

**2. Install dependencies**
\`\`\`bash
npm install
\`\`\`

**3. Create your .env file**
\`\`\`bash
cp .env.example .env
\`\`\`
Add your Anthropic API key to `.env`:
\`\`\`
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
PORT=3000
\`\`\`

**4. Start the server**
\`\`\`bash
node server.js
\`\`\`

**5. Open in browser**
\`\`\`
http://localhost:3000
\`\`\`

## 📁 Project Structure

\`\`\`
salesforce-copilot/
├── server.js          # Express backend + Claude API
├── lib/usage-store.js # Usage limits and leads
├── test/              # Server tests (fake Claude client)
├── public/
│   └── index.html     # Frontend UI
├── .env.example       # Template for environment variables
├── .gitignore
└── package.json
\`\`\`

## 🔒 Security

- Never commit your `.env` file (already in `.gitignore`)
- API keys are server-side only, never exposed to the browser

## 🔐 Access and usage limits

- **Free sample:** visitors enter an email and get 3 questions. Each email address is counted once, including Gmail dots and `+tag` variants.
- **Paid access:** buyers type the password set in `PAID_ACCESS_CODE`. It is checked on the server, never stored in the page.
- **Cost protection:** a per-network daily limit, a daily limit for free samples, and a global daily limit all apply, so a leaked password cannot run up the Anthropic bill. Defaults are in `.env.example`.
- **Leads:** each new free-sample email is appended to `data/leads.jsonl` and printed to the server log as `LEAD`. On Railway, attach a volume and set `DATA_DIR` to its path if you want usage counts and leads to survive redeploys. If `LEADS_WEBHOOK_URL` and `LEADS_WEBHOOK_SECRET` are set, each new lead is also posted to a Google Sheet through an Apps Script web app (best effort; a failure never blocks a question).
- **Tests:** `npm test` runs the server tests with a fake Claude client (no API calls).

## 📄 License

MIT

## 👤 Author

Built by [Surya VJ](https://github.com/suryavijayakumar03) — Salesforce Admin & Business Systems Engineer

*Powered by [Anthropic Claude AI](https://anthropic.com)*
