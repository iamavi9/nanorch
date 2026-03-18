import type { Request, Response } from "express";
import { storage } from "../storage";
import { executeTask } from "../engine/executor";

export interface TeamsChannelConfig {
  appId?: string;
  appPassword?: string;
  defaultAgentId?: string;
  url?: string;
  events?: string[];
  isInbound?: boolean;
}

interface TeamsOAuthToken {
  access_token: string;
  expires_at: number;
}

const tokenCache = new Map<string, TeamsOAuthToken>();

async function getTeamsBotToken(appId: string, appPassword: string): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.access_token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: appId,
    client_secret: appPassword,
    scope: "https://api.botframework.com/.default",
  });

  const res = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  if (!res.ok) throw new Error(`Teams token fetch failed: ${res.status}`);
  const data = await res.json() as any;
  const token: TeamsOAuthToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  tokenCache.set(appId, token);
  return token.access_token;
}

async function verifyTeamsJwt(authHeader: string): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    const [, payload64] = authHeader.slice(7).split(".");
    const payload = JSON.parse(Buffer.from(payload64, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return false;
    if (payload.iss && !payload.iss.includes("botframework.com") && !payload.iss.includes("microsoftonline.com")) return false;
    return true;
  } catch {
    return false;
  }
}

export async function replyToTeams(
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  text: string,
  appId: string,
  appPassword: string,
): Promise<void> {
  const token = await getTeamsBotToken(appId, appPassword);
  const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${conversationId}/activities/${activityId}`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", text }),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function handleTeamsEvent(channelId: string, req: Request, res: Response): Promise<void> {
  const channel = await storage.getChannel(channelId);
  if (!channel) { res.status(404).json({ error: "channel not found" }); return; }

  const cfg = channel.config as TeamsChannelConfig;
  if (!cfg?.isInbound) { res.status(403).json({ error: "not an inbound channel" }); return; }

  const authHeader = req.headers["authorization"] as string;
  const valid = await verifyTeamsJwt(authHeader);
  if (!valid) { res.status(401).json({ error: "invalid token" }); return; }

  const activity = req.body as any;

  if (activity.type !== "message") { res.status(200).json({}); return; }

  res.status(200).json({});

  const rawText = (activity.text || "").replace(/<[^>]*>/g, "").trim();
  if (!rawText) return;

  const agentNameMatch = rawText.match(/^use\s+([\w-]+)\s*:\s*([\s\S]*)/i);
  const prompt = agentNameMatch ? agentNameMatch[2].trim() : rawText;
  const agentName = agentNameMatch ? agentNameMatch[1] : null;

  const orchestrator = await storage.getOrchestratorForChannel(channelId);
  if (!orchestrator) return;

  let agentId = cfg.defaultAgentId;
  if (agentName) {
    const agents = await storage.listAgents(orchestrator.id);
    const matched = agents.find((a) => a.name.toLowerCase() === agentName!.toLowerCase());
    if (matched) agentId = matched.id;
  }
  if (!agentId) {
    const agents = await storage.listAgents(orchestrator.id);
    if (agents.length > 0) agentId = agents[0].id;
  }
  if (!agentId) return;

  const conversationId = activity.conversation?.id;
  const activityId = activity.id;
  const serviceUrl = activity.serviceUrl;
  const externalUserId = activity.from?.id;
  const externalUserName = activity.from?.name;

  const threadKey = conversationId || activityId;

  let thread = await storage.getCommsThread(channelId, threadKey);
  if (!thread) {
    thread = await storage.createCommsThread({
      channelId,
      externalThreadId: threadKey,
      externalChannelId: conversationId,
      externalUserId,
      externalUserName,
      agentId,
      platform: "teams",
      conversationRef: {
        serviceUrl,
        conversationId,
        activityId,
        appId: cfg.appId,
        appPassword: cfg.appPassword,
      },
      lastActivityAt: new Date(),
    });
  } else {
    await storage.touchCommsThread(thread.id);
    const ref = (thread.conversationRef as any) || {};
    ref.activityId = activityId;
    await storage.updateCommsThreadRef(thread.id, ref);
  }

  const task = await storage.createTask({
    orchestratorId: orchestrator.id,
    agentId,
    channelId,
    commsThreadId: thread.id,
    input: prompt,
    status: "pending",
    priority: 5,
  });

  setImmediate(() => executeTask(task.id).catch(console.error));
}
