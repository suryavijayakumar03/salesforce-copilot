const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

app.post("/api/ask", async (req, res) => {
  const { question } = req.body;

  if (!question || question.trim().length === 0) {
    return res.status(400).json({ error: "Question is required" });
  }

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: question }],
    });

    res.json({ answer: message.content[0].text });
  } catch (error) {
    console.error("Claude API error:", error);
    res.status(500).json({ error: "Failed to get answer. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Salesforce Copilot running at http://localhost:${PORT}\n`);
});
