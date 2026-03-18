import { storage } from "../storage";

async function replyToSlack(
  channel: string,
  threadTs: string,
  botToken: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json() as any;
  if (!data.ok) {
    console.error("[comms-reply] Slack postMessage failed:", data.error);
  }
}

async function replyToTeams(
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  appId: string,
  appPassword: string,
  text: string,
): Promise<void> {
  const { replyToTeams: _reply } = await import("./teams-handler");
  await _reply(serviceUrl, conversationId, activityId, text, appId, appPassword);
}

export async function dispatchCommsReply(commsThreadId: string, text: string): Promise<void> {
  try {
    const thread = await storage.getCommsThreadById(commsThreadId);
    if (!thread) return;

    const ref = (thread.conversationRef || {}) as Record<string, string>;

    if (thread.platform === "slack") {
      const botToken = ref.botToken;
      const slackChannel = ref.channel;
      const threadTs = ref.thread_ts;
      if (!botToken || !slackChannel || !threadTs) return;
      await replyToSlack(slackChannel, threadTs, botToken, text);
    } else if (thread.platform === "teams") {
      const { serviceUrl, conversationId, activityId, appId, appPassword } = ref;
      if (!serviceUrl || !conversationId || !activityId || !appId || !appPassword) return;
      await replyToTeams(serviceUrl, conversationId, activityId, appId, appPassword, text);
    }
  } catch (err) {
    console.error("[comms-reply] Failed to dispatch reply:", err);
  }
}
