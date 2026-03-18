import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { storage } from "../storage";
import { executeTask } from "../engine/executor";

export interface SlackChannelConfig {
  botToken?: string;
  signingSecret?: string;
  defaultAgentId?: string;
  url?: string;
  events?: string[];
  isInbound?: boolean;
}

function verifySlackSignature(signingSecret: string, req: Request): boolean {
  const timestamp = req.headers["x-slack-request-timestamp"] as string;
  const slackSig = req.headers["x-slack-signature"] as string;
  if (!timestamp || !slackSig) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const rawBody = (req as any).rawBody as string | undefined;
  if (!rawBody) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = "v0=" + createHmac("sha256", signingSecret).update(baseString).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
  } catch {
    return false;
  }
}

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function parseAgentName(text: string): { agentName: string | null; prompt: string } {
  const match = text.match(/^use\s+([\w-]+)\s*:\s*([\s\S]*)/i);
  if (match) return { agentName: match[1], prompt: match[2].trim() };
  return { agentName: null, prompt: text };
}

export async function handleSlackEvent(channelId: string, req: Request, res: Response): Promise<void> {
  const channel = await storage.getChannel(channelId);
  if (!channel) { res.status(404).json({ error: "channel not found" }); return; }

  const cfg = channel.config as SlackChannelConfig;
  if (!cfg?.isInbound) { res.status(403).json({ error: "not an inbound channel" }); return; }

  if (cfg.signingSecret) {
    if (!verifySlackSignature(cfg.signingSecret, req)) {
      res.status(401).json({ error: "invalid signature" }); return;
    }
  }

  const body = req.body as any;

  if (body.type === "url_verification") {
    res.json({ challenge: body.challenge }); return;
  }

  if (body.type === "event_callback") {
    const event = body.event;

    if (!event || (event.type !== "app_mention" && event.type !== "message")) {
      res.status(200).json({ ok: true }); return;
    }

    if (event.bot_id || event.subtype === "bot_message") {
      res.status(200).json({ ok: true }); return;
    }

    res.status(200).json({ ok: true });

    const rawText = stripMentions(event.text || "");
    if (!rawText) return;

    const { agentName, prompt } = parseAgentName(rawText);

    const orchestrator = await storage.getOrchestratorForChannel(channelId);
    if (!orchestrator) return;

    let agentId = cfg.defaultAgentId;
    if (agentName) {
      const agents = await storage.listAgents(orchestrator.id);
      const matched = agents.find(
        (a) => a.name.toLowerCase() === agentName.toLowerCase(),
      );
      if (matched) agentId = matched.id;
    }
    if (!agentId) {
      const agents = await storage.listAgents(orchestrator.id);
      if (agents.length > 0) agentId = agents[0].id;
    }
    if (!agentId) return;

    const threadId = event.thread_ts || event.ts;

    let thread = await storage.getCommsThread(channelId, threadId);
    if (!thread) {
      thread = await storage.createCommsThread({
        channelId,
        externalThreadId: threadId,
        externalChannelId: event.channel,
        externalUserId: event.user,
        externalUserName: event.user,
        agentId,
        platform: "slack",
        conversationRef: {
          channel: event.channel,
          thread_ts: threadId,
          botToken: cfg.botToken,
        },
        lastActivityAt: new Date(),
      });
    } else {
      await storage.touchCommsThread(thread.id);
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
    return;
  }

  res.status(200).json({ ok: true });
}
