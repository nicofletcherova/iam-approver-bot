import express from "express";
import bodyParser from "body-parser"; // needed for Slack slash commands
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- ENV VARS ---
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-...
const SHARED_SECRET = process.env.SHARED_SECRET;     // a long random string
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "200", 10);
const JIRA_BASE_URL = process.env.JIRA_BASE_URL; // e.g., https://yourcompany.atlassian.net
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL; // Jira API user email
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

// --- Jira query helper ---
async function jiraGet(jql) {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search?jql=${encodeURIComponent(jql)}`, {
    headers: {
      "Authorization": "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"),
      "Accept": "application/json"
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessages || "Jira query failed");
  return data.issues || [];
}

// --- security middleware for Jira webhook ---
app.use((req, res, next) => {
  // allow slash commands and Slack actions
  if (req.path.startsWith("/approval") || req.path.startsWith("/slack-actions")) return next();

  const auth = (req.headers.authorization || "").trim();
  if (!SHARED_SECRET || auth === `Bearer ${SHARED_SECRET}`) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// --- main endpoint: DM approvers when ticket enters awaiting approval ---
app.post("/notify-approver", async (req, res) => {
  try {
    const body = req.body || {};
    let emails = body.approverEmails || [];
    if (!Array.isArray(emails)) emails = [emails].filter(Boolean);

    if (emails.length === 0) return res.status(400).json({ ok: false, error: "no approverEmails provided" });

    const { issueKey, issueSummary, issueUrl, requester } = body;
    const results = [];

    for (const email of emails) {
      try {
        const userId = await lookupUserIdByEmail(email);

        await slackPost("chat.postMessage", {
          channel: userId,
          text: " ", // fallback
          attachments: [
            {
              color: "#4D008C",
              blocks: [
                {
                  type: "header",
                  text: { type: "plain_text", text: "🔵 IAM Approval Requested", emoji: true }
                },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: `*Ticket:*\n<${issueUrl}|${issueKey}>` },
                    { type: "mrkdwn", text: `*Summary:*\n${issueSummary}` },
                    { type: "mrkdwn", text: "\n" },
                    { type: "mrkdwn", text: `*Requester:*\n${requester}` },
                    { type: "mrkdwn", text: `*Approvers:*\n<@${userId}>` }
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
                    { type: "mrkdwn", text: "Please approve/reject in Jira. Replying here won’t approve it." }
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

      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error("Unhandled error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Slash command /approval ---
app.post("/approval", async (req, res) => {
  try {
    const slackUserId = req.body.user_id;

    // lookup Slack user's email
    const userInfo = await slackPost("users.info", { user: slackUserId });
    const email = userInfo.user.profile.email;

    // query Jira for tickets awaiting this user's approval
    const jql = `"Approver" = "${email}" AND status = "Awaiting Approval" ORDER BY created DESC`;
    const issues = await jiraGet(jql);

    if (!issues.length) {
      return res.json({
        response_type: "ephemeral",
        text: "✅ You have no tickets awaiting your approval."
      });
    }

    const blocks = issues.flatMap(issue => {
      const key = issue.key;
      const summary = issue.fields.summary;
      const url = `${JIRA_BASE_URL}/browse/${key}`;
      return [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*<${url}|${key}>* — ${summary}` }
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "✅ Approve" }, style: "primary", value: JSON.stringify({ key, transitionId: 61 }) },
            { type: "button", text: { type: "plain_text", text: "❌ Reject" }, style: "danger", value: JSON.stringify({ key, transitionId: 51 }) }
          ]
        },
        { type: "divider" }
      ];
    });

    return res.json({ response_type: "ephemeral", blocks });
  } catch (err) {
    console.error("Error in /approval:", err);
    return res.json({ response_type: "ephemeral", text: `⚠️ Something went wrong: ${err.message}` });
  }
});

// --- Slack interactive actions handler ---
app.post("/slack-actions", bodyParser.urlencoded({ extended: true }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    const action = JSON.parse(payload.actions[0].value); // { key, transitionId }
    const issueKey = action.key;
    const transitionId = action.transitionId;

    // call Jira transition API
    const jiraRes = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/transitions`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ transition: { id: transitionId } })
    });

    if (!jiraRes.ok) {
      const errData = await jiraRes.json();
      throw new Error(errData.errorMessages || "Jira transition failed");
    }

    // update Slack message to confirm action
    await fetch(payload.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: `✅ Issue *${issueKey}* has been transitioned successfully.`
      })
    });

    res.send(""); // acknowledge Slack
  } catch (err) {
    console.error("Slack action error:", err);
    res.send(""); // still acknowledge
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
