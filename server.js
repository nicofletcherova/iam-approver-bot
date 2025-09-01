// --- main endpoint: DM approvers ---
app.post("/notify-approver", async (req, res) => {
  try {
    const body = req.body || {};
    let emails = body.approverEmails || [];
    if (!Array.isArray(emails)) emails = [emails].filter(Boolean);
    if (!emails.length) return res.status(400).json({ ok: false, error: "no approverEmails provided" });

    const { issueKey, issueSummary, issueUrl, requester, subsystems } = body;
    const results = [];

    for (const email of emails) {
      try {
        const userId = await lookupUserIdByEmail(email);

        // Build the fields dynamically
        const fields = [
          { type: "mrkdwn", text: `*Ticket:*\n<${issueUrl}|${issueKey}>` },
          { type: "mrkdwn", text: `*Requester:*\n${requester}` },
          { type: "mrkdwn", text: `*Summary:*\n${issueSummary}` },
          { type: "mrkdwn", text: `*Approvers:*\n<@${userId}>` }
        ];
        if (subsystems) {
          fields.push({ type: "mrkdwn", text: `*Subsystems:*\n${subsystems}` });
        }

        await slackPost("chat.postMessage", {
          channel: userId,
          text: `Approval requested: ${issueKey} — ${issueSummary}`,
          blocks: [
            { type: "header", text: { type: "plain_text", text: "🔵 IAM Approval Requested", emoji: true } },
            { type: "section", fields },
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

// --- Slack action handler ---
app.post("/slack-actions", async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    const action = payload.actions[0];
    const { issueKey, transitionId } = JSON.parse(action.value);

    // transition in Jira
    await jiraTransition(issueKey, transitionId);

    // fetch Slack user info for name
    const slackUserInfo = await slackPost("users.info", { user: payload.user.id });
    const approverName = slackUserInfo.user?.profile?.real_name || slackUserInfo.user?.profile?.display_name || slackUserInfo.user?.name || payload.user.id;

    const decision = transitionId === 61 ? "✅ Approved" : "❌ Rejected";
    await jiraAddComment(issueKey, `${decision} by ${approverName} (via IAM Approver Slack bot)`);

    // pick correct ts
    const ts = payload.message?.ts || payload.container?.message_ts;

    // update Slack message (remove buttons)
    await slackPost("chat.update", {
      channel: payload.channel.id,
      ts,
      text: `Ticket ${issueKey} has been ${decision}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${issueKey}* has been ${decision} by ${approverName}` }
        }
      ]
    });

    res.send(""); // quick ack
  } catch (err) {
    console.error("Error handling Slack action:", err);
    res.status(500).send("Error processing action");
  }
});
