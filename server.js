import express from "express";

const app = express();
app.use(express.json());

// --- ENV VARS ---
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-...
const SHARED_SECRET = process.env.SHARED_SECRET;     // a long random string
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "200", 10);

if (!SLACK_BOT_TOKEN) {
  console.error("Missing SLACK_BOT_TOKEN env var. Exiting.");
  process.exit(1);
}

// --- helper functions ---
async function slackPost(method, payload, query = "") {
  const res = await fetch(`https://slack.com/api/${method}${query}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
  return data;
}

async function lookupUserIdByEmail(email) {
  const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`lookupByEmail(${email}) failed: ${data.error}`);
  return data.user.id;
}

// --- security middleware ---
app.use((req, res, next) => {
  const auth = (req.headers.authorization || "").trim();
  if (!SHARED_SECRET || auth === `Bearer ${SHARED_SECRET}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// --- main endpoint ---
app.post("/notify-approver", async (req, res) => {
  try {
    const body = req.body || {};
    let emails = body.approverEmails || [];
    if (!Array.isArray(emails)) emails = [emails].filter(Boolean);

    if (emails.length === 0) {
      return res.status(400).json({ ok: false, error: "no approverEmails provided" });
    }

    const { issueKey, issueSummary, issueUrl, requester } = body;
    const results = [];

    for (const email of emails) {
      try {
        const userId = await lookupUserIdByEmail(email);

        // Send DM
        await slackPost("chat.postMessage", {
  channel: userId,
  text: `🚨 IAM Approval Requested`, // fallback text
  attachments: [
    {
      color: "#4D008C", 
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🚨 IAM Approval Requested", emoji: true }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Ticket:*\n<${issueUrl}|${issueKey}>` },
            { type: "mrkdwn", text: `*Summary:*\n${issueSummary}` },
            { type: "mrkdwn", text: `*Requester:*\n${requester}` },
            { type: "mrkdwn", text: `*Approver:*\n<@${userId}>` }
          ]
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open in Jira" },
              url: issueUrl,
              style: "primary"
            }
          ]
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "Please approve/reject in Jira by changing the status of the ticket. Replying here won’t approve it." }
          ]
        }
      ]
    }
  ]
});


        results.push({ email, ok: true });
      } catch (err) {
        results.push({ email, ok: false, error: err.message });
      }

      // rate limit pause
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error("Unhandled error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));

