import express from "express";
import bodyParser from "body-parser"; // for Slack actions
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- ENV VARS ---
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SHARED_SECRET = process.env.SHARED_SECRET;
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "200", 10);
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

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
      "Content-Type": "application/json; charset=utf-8`
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
  return data;
}

async function lookupUserIdByEmail(email) {
  const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  const data = await res.json();
  if (!data.ok) throw new Error(`lookupByEmail(${email}) failed: ${data.error}`);
  return data.user.id;
}

async function jiraTransition(issueKey, transitionId) {
  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/transitions`;
  const body = { transition: { id: transitionId.toString() } };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Jira transition failed for ${issueKey}`);
}

async function jiraAddComment(issueKey, comment) {
  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`;
  const body = {
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: comment }]
        }
      ]
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to add comment to ${issueKey}: ${errText}`);
  }
}

// --- security middleware ---
app.use((req, res, next) => {
  if (req.path.startsWith("/slack-actions")) return next();
  const auth = (req.headers.authorization || "").trim();
  if (!SHARED_SECRET || auth === `Bearer ${SHARED_SECRET}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// --- main endpoint: DM approvers ---
app.post("/notify-approver", async (req, res) => {
  try {
    const body = req.body || {};
    let emails = body.approverEmails || [];
    if (!Array.isArray(emails)) emails = [emails].filter(Boolean);
    if (!emails.length) return res.status(400).json({ ok: false, error: "no approverEmails provided" });

    const { issueKey, issueSummary, issueUrl, requester } = body;
    const results = [];

    for (const email of emails) {
      try {
        const userId = await lookupUserIdByEmail(email);

        await slackPost("chat.postMessage", {
          channel: userId,
          text: `Approval requested: ${issueKey} — ${issueSummary}`,
          blocks: [
            { type: "header", text: { type: "plain_text", text: "🔵 IAM Approval Requested", emoji: true } },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Ticket:*\n<${issueUrl}|${issueKey}>` },
                { type: "mrkdwn", text: `*Requester:*\n${requester}` },
                { type: "mrkdwn", text: `*Summary:*\n${issueSummary}` },
                { type: "mrkdwn", text: `*Approvers:*\n<@${userId}>` }
              ]
            },
            {
              type: "actions",
              elements: [
                { type: "button", text: { type: "plain_text", text: "✅ Approve" }, style: "primary", value: JSON.stringify({ issueKey, transitionId: 61 }) },
                { type: "button", text: { type: "plain_text", text: "❌ Reject" }, style: "danger", value: JSON.stringify({ issueKey, transitionId: 51 }) },
                { type: "button", text: { type: "plain_text", text: "Open in Jira" }, url: issueUrl, style: "primary" }
              ]
            },
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: "Please approve/reject in Jira by clicking above. Replying here won’t approve it." }
              ]
            }
          ]
        });

        results.push({ email, ok: true });
      } catch (err) {
        results.push({ email, ok: false, error: err.message });
      }

      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error("Unhandled error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- endpoint to handle Slack button clicks ---
app.post("/slack-actions", async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    const action = payload.actions[0];
    const { issueKey, transitionId } = JSON.parse(action.value);

    // transition in Jira
    await jiraTransition(issueKey, transitionId);

    // add comment in Jira (logs the approver’s Slack identity)
    const slackUser = `<@${payload.user?.id}>`;
    const decision = transitionId === 61 ? "✅ Approved" : "❌ Rejected";
    await jiraAddComment(issueKey, `${decision} by ${slackUser} (via IAM Approver Slack bot)`);

    // pick correct ts (message.ts OR container.message_ts)
    const ts = payload.message?.ts || payload.container?.message_ts;

    // update Slack message (remove buttons)
    await slackPost("chat.update", {
      channel: payload.channel.id,
      ts,
      text: `Ticket ${issueKey} has been ${decision}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${issueKey}* has been ${decision} by <@${payload.user.id}>`
          }
        }
      ]
    });

    res.send(""); // quick ack
  } catch (err) {
    console.error("Error handling Slack action:", err);
    res.status(500).send("Error processing action");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
