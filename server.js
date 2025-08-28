import express from "express";

const app = express();
app.use(express.json());

// --- ENV VARS (set these in Render / your host)
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-...
const SHARED_SECRET = process.env.SHARED_SECRET;     // a long random string
const NOTIFY_STRATEGY = process.env.NOTIFY_STRATEGY || "all"; // "all" or "first"
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "200", 10); // pause between messages

if (!SLACK_BOT_TOKEN) {
  console.error("Missing SLACK_BOT_TOKEN env var. Exiting.");
  process.exit(1);
}

// helper: generic Slack POST
async function slackPost(method, payload, query = "") {
  const url = `https://slack.com/api/${method}${query}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.error || JSON.stringify(data)}`);
  return data;
}

// helper: lookup Slack user ID by email (GET)
async function lookupUserIdByEmail(email) {
  const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }});
  const data = await res.json();
  if (!data.ok) throw new Error(`lookupByEmail(${email}) failed: ${data.error || JSON.stringify(data)}`);
  return data.user.id;
}

// security middleware
app.use((req, res, next) => {
  const auth = (req.headers.authorization || "").trim();
  if (!SHARED_SECRET || auth === `Bearer ${SHARED_SECRET}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// main endpoint
app.post("/notify-approver", async (req, res) => {
  try {
    const body = req.body || {};
    let emails = body.approverEmails || [];
    if (!Array.isArray(emails)) emails = [emails].filter(Boolean);

    if (emails.length === 0) {
      return res.status(400).json({ ok: false, error: "no approverEmails provided" });
    }

    if (NOTIFY_STRATEGY === "first") emails = [emails[0]];

    const { issueKey, issueSummary, issueUrl, requester } = body;
    const text = `Approval requested: ${issueKey} — ${issueSummary}`;

    const results = [];
    for (const email of emails) {
      try {
        // lookup Slack user
        const userId = await lookupUserIdByEmail(email);

        // post a DM (channel = userId)
        await slackPost("chat.postMessage", {
          channel: userId,
          text: `${text}\n${issueUrl || ""}`,
          blocks: [
            { type: "header", text: { type: "plain_text", text: "Approval requested" } },
            {
              type: "section",
              text: { type: "mrkdwn",
                text: `*${issueKey}* — ${issueSummary}\n${requester ? `*Requester:* ${requester}\n` : ""}${issueUrl ? `<${issueUrl}|Open in Jira>` : ""}`
              }
            },
            { type: "context", elements: [{ type: "mrkdwn", text: "Please approve in Jira. Replying here won’t approve it." }] }
          ]
        });

        results.push({ email, ok: true });
      } catch (err) {
        results.push({ email, ok: false, error: err.message });
      }
      // pause a bit to be polite with rate limits
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error("Unhandled:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
