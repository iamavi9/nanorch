import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { startQueueWorker } from "./engine/queue";
import { taskLogEmitter } from "./engine/emitter";
import { PROVIDER_MODELS, runAgent } from "./providers";
import { insertWorkspaceSchema, insertOrchestratorSchema, insertAgentSchema, insertChannelSchema, insertTaskSchema } from "@shared/schema";
import { randomUUID } from "crypto";
import { encrypt, decrypt } from "./lib/encryption";
import { validateCredentials, executeCloudTool, retrieveRAGFlowContext } from "./cloud/executor";
import { getToolsForProvider, detectProviderFromToolName, CODE_INTERPRETER_TOOL, SPAWN_AGENT_TOOL } from "./cloud/tools";
import type { ToolDefinition } from "./providers";
import { runCode } from "./engine/sandbox-executor";
import { executeTask } from "./engine/executor";
import { db } from "./db";
import { tasks } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword, requireAuth, requireAdmin, requireWorkspaceAdmin } from "./lib/auth";
import { computeNextRun, validateCron, registerJob, unregisterJob } from "./engine/scheduler";
import { insertScheduledJobSchema } from "@shared/schema";
import { executePipeline } from "./engine/pipeline-executor";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { loadSecret } from "./lib/secrets";
import { handleSlackEvent } from "./comms/slack-handler";
import { handleTeamsEvent } from "./comms/teams-handler";

// ── Chat title generator ───────────────────────────────────────────────────────
async function generateChatTitle(firstMessage: string): Promise<string> {
  const prompt = `Generate a concise 3-6 word title for a chat conversation that starts with the following user message. Reply with only the title — no quotes, no punctuation at the end, no explanation.\n\nUser message: ${firstMessage.slice(0, 300)}`;
  try {
    const openaiKey = loadSecret("AI_INTEGRATIONS_OPENAI_API_KEY");
    if (openaiKey) {
      const client = new OpenAI({ apiKey: openaiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
      const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 20,
        temperature: 0.4,
      });
      const title = res.choices[0]?.message?.content?.trim();
      if (title) return title;
    }
  } catch { /* fallthrough */ }
  try {
    const anthropicKey = loadSecret("AI_INTEGRATIONS_ANTHROPIC_API_KEY");
    if (anthropicKey) {
      const client = new Anthropic({ apiKey: anthropicKey, baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL });
      const res = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 20,
        messages: [{ role: "user", content: prompt }],
      });
      const block = res.content[0];
      const title = block?.type === "text" ? block.text.trim() : undefined;
      if (title) return title;
    }
  } catch { /* fallthrough */ }
  // Fallback: derive title from first few words of the message
  const words = firstMessage.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 40 ? words.slice(0, 40) + "…" : words;
}

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Webhook rate limit exceeded. Maximum 60 requests per minute." },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
  skip: (req) => req.path.startsWith("/api/tasks/") && req.path.endsWith("/stream"),
});

type WorkspaceAgentMeta = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  tools: unknown;
  maxTokens: number | null;
  temperature: number | null;
  provider: string;
  model: string;
  baseUrl: string | null;
};

type LoadedCred = { provider: string; credentials: any; integrationId: string };

async function runSubtaskAgent(params: {
  agentId: string;
  prompt: string;
  subtaskId: string;
  loadedCreds: LoadedCred[];
  allWorkspaceAgents: WorkspaceAgentMeta[];
  send: (data: object) => void;
}): Promise<string> {
  const { agentId, prompt, subtaskId, loadedCreds, allWorkspaceAgents, send } = params;
  const agentMeta = allWorkspaceAgents.find((a) => a.id === agentId);
  if (!agentMeta) throw new Error(`Agent ${agentId} not found in workspace`);

  const systemPrompt = agentMeta.instructions || "You are a helpful AI assistant.";
  const agentEnabledTools: string[] = Array.isArray(agentMeta.tools) ? (agentMeta.tools as string[]) : [];

  const allAvailableTools: ToolDefinition[] = [];
  for (const cred of loadedCreds) {
    allAvailableTools.push(...getToolsForProvider(cred.provider as any));
  }
  const agentTools = agentEnabledTools.length > 0
    ? allAvailableTools.filter((t) => agentEnabledTools.includes(t.name))
    : [];

  const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
    { role: "user", content: prompt },
  ];

  let accumulated = "";

  if (agentTools.length === 0) {
    await runAgent({
      provider: agentMeta.provider as any,
      model: agentMeta.model,
      baseUrl: agentMeta.baseUrl,
      systemPrompt,
      messages,
      maxTokens: agentMeta.maxTokens ?? 4096,
      temperature: agentMeta.temperature ?? 70,
      onChunk: (chunk) => {
        accumulated += chunk;
        send({ type: "subtask_chunk", subtaskId, content: chunk });
      },
    });
  } else {
    const MAX_SUBTASK_ROUNDS = 5;
    let done = false;
    let rounds = 0;

    while (!done && rounds < MAX_SUBTASK_ROUNDS) {
      const result = await runAgent({
        provider: agentMeta.provider as any,
        model: agentMeta.model,
        baseUrl: agentMeta.baseUrl,
        systemPrompt,
        messages,
        maxTokens: agentMeta.maxTokens ?? 4096,
        temperature: agentMeta.temperature ?? 70,
        tools: agentTools,
      });

      if (!result.toolCalls || result.toolCalls.length === 0) {
        accumulated = result.content;
        send({ type: "subtask_chunk", subtaskId, content: result.content });
        done = true;
        break;
      }

      if (result.content) messages.push({ role: "assistant", content: result.content });

      for (const toolCall of result.toolCalls) {
        const provider = detectProviderFromToolName(toolCall.name);
        const cred = loadedCreds.find((c) => c.provider === provider);
        if (!cred) {
          messages.push({ role: "user", content: `Tool ${toolCall.name} result: ERROR — No ${provider} integration configured` });
          continue;
        }
        try {
          const toolResult = await executeCloudTool(toolCall.name, toolCall.arguments, cred as any);
          messages.push({ role: "user", content: `Tool ${toolCall.name} result:\n${JSON.stringify(toolResult, null, 2)}` });
        } catch (err: any) {
          messages.push({ role: "user", content: `Tool ${toolCall.name} result: ERROR — ${err.message}` });
        }
      }
      rounds++;
    }

    if (!done) {
      const finalResult = await runAgent({
        provider: agentMeta.provider as any,
        model: agentMeta.model,
        baseUrl: agentMeta.baseUrl,
        systemPrompt,
        messages: [...messages, { role: "user", content: "Please provide your final answer based on the information gathered." }],
        maxTokens: agentMeta.maxTokens ?? 4096,
        temperature: agentMeta.temperature ?? 70,
        onChunk: (chunk) => {
          accumulated += chunk;
          send({ type: "subtask_chunk", subtaskId, content: chunk });
        },
      });
      accumulated = finalResult.content;
    }
  }

  return accumulated;
}

async function classifyIntent(content: string, provider: string, model: string, baseUrl?: string | null): Promise<"action" | "code_execution" | "conversational"> {
  try {
    const result = await runAgent({
      provider: provider as any,
      model,
      baseUrl,
      systemPrompt:
        "You are an intent classifier. Reply with ONLY one word: 'action', 'code_execution', or 'conversational'.\n" +
        "'action' = the message wants to perform a cloud or DevOps operation that writes, mutates, or manages infrastructure: create/update/delete/deploy/run/trigger/manage resources on AWS, GCP, Azure, Jira, GitHub, or GitLab. Also 'action' for read-only queries on those platforms (list EC2 instances, search Jira issues, list PRs, etc.).\n" +
        "'code_execution' = the message asks to write code, run code, execute a script, show a code example with output, compute something programmatically, analyse data, demonstrate a programming concept with working code, or produce any output that requires running code (e.g. Hello World, fibonacci, hash, date calculations, sorting, etc.). Languages include Python, JavaScript, Bash, Ruby, R, Go, and Java.\n" +
        "'conversational' = general questions, explanations, knowledge base lookups (RAGFlow / documentation search), greetings, discussion, summarisation, or anything that does not require operating on cloud infrastructure or developer platforms.",
      messages: [{ role: "user", content }],
      maxTokens: 5,
      temperature: 0,
    });
    const word = result.content.trim().toLowerCase().split(/\s/)[0];
    if (word === "action") return "action";
    if (word === "code_execution") return "code_execution";
    return "conversational";
  } catch {
    return "conversational";
  }
}

const BYPASS_PHRASES = [
  "without approval",
  "skip approval",
  "approval not needed",
  "no approval needed",
  "bypass approval",
];

function hasApprovalBypass(content: string): boolean {
  const lower = content.toLowerCase();
  return BYPASS_PHRASES.some((phrase) => lower.includes(phrase));
}

interface PreflightOperation {
  tool: string;
  description: string;
  riskLevel: "read-only" | "creates" | "modifies" | "deletes";
}

interface PreflightResult {
  summary: string;
  operations: PreflightOperation[];
}

async function runPreflightAnalysis(
  content: string,
  tools: ToolDefinition[],
  provider: string,
  model: string,
  baseUrl?: string | null
): Promise<PreflightResult | null> {
  if (tools.length === 0) return null;
  try {
    const toolList = tools.map((t) => `${t.name}: ${t.description}`).join("\n");
    const result = await runAgent({
      provider: provider as any,
      model,
      baseUrl,
      systemPrompt:
        `You are a pre-flight analyzer. Given a user request and the available tools, predict exactly what tool calls will be made to fulfil it.\n` +
        `Available tools:\n${toolList}\n\n` +
        `Reply with ONLY valid JSON — no markdown fences, no explanation:\n` +
        `{"summary":"one sentence plain-english summary of what will happen","operations":[{"tool":"exact_tool_name","description":"what this specific call does in plain english","riskLevel":"read-only"}]}\n` +
        `riskLevel must be exactly one of: read-only, creates, modifies, deletes`,
      messages: [{ role: "user", content }],
      maxTokens: 400,
      temperature: 0,
    });
    const cleaned = result.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned) as PreflightResult;
  } catch {
    return null;
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await db.update(tasks)
    .set({ status: "failed", errorMessage: "Interrupted by server restart", completedAt: new Date() })
    .where(eq(tasks.status, "running"));

  startQueueWorker();

  app.use(apiLimiter);

  // Trust reverse-proxy headers (X-Forwarded-For, X-Forwarded-Proto).
  // Needed for accurate rate-limiting and for secure cookies to work
  // correctly when behind nginx / traefik / AWS ALB.
  app.set("trust proxy", 1);

  const PgSession = connectPgSimple(session);
  app.use(session({
    secret: process.env.SESSION_SECRET || "nanoorch-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // Only mark cookies as secure when explicitly opted in via env var.
      // Defaulting to NODE_ENV=production breaks plain-HTTP Docker deployments
      // because browsers silently drop secure cookies over HTTP.
      // Set COOKIE_SECURE=true in .env when running behind an HTTPS reverse proxy.
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    // PostgreSQL-backed session store — sessions survive container restarts
    // and are not lost under memory pressure like the in-memory store.
    store: new PgSession({
      conString: process.env.DATABASE_URL,
      tableName: "user_sessions",
      pruneSessionInterval: 60 * 60, // prune expired sessions hourly
    }),
  }));

  // ── CSRF protection ───────────────────────────────────────────────────────
  // Applies to all state-changing requests from authenticated browser sessions.
  // Exemptions: login (no session yet) and inbound webhook (external callers).
  app.use((req, res, next) => {
    const method = req.method.toUpperCase();
    if (!["POST", "PUT", "DELETE", "PATCH"].includes(method)) return next();
    if (req.path === "/api/auth/login") return next();
    if (/^\/api\/channels\/[^/]+\/webhook$/.test(req.path)) return next();
    if (/^\/api\/channels\/[^/]+\/slack\/events$/.test(req.path)) return next();
    if (/^\/api\/channels\/[^/]+\/teams\/events$/.test(req.path)) return next();
    if (!req.session?.userId) return next();
    const token = req.headers["x-csrf-token"] as string | undefined;
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: "Invalid or missing CSRF token" });
    }
    next();
  });

  // ── Auth routes (public) ──────────────────────────────────────────────────
  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const user = await storage.getUserByUsername(username);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    // Regenerate session ID to prevent session fixation, then persist data
    // before sending the response. With async stores (PostgreSQL) the session
    // must be fully written to the DB BEFORE the response is sent — otherwise
    // the next request arrives with a session ID that doesn't exist yet → 401.
    req.session.regenerate((regenErr) => {
      if (regenErr) return res.status(500).json({ error: "Session error" });
      req.session.userId = user.id;
      req.session.userRole = user.role ?? "member";
      req.session.csrfToken = randomUUID();
      req.session.save(async (saveErr) => {
        if (saveErr) return res.status(500).json({ error: "Session save error" });
        const workspaceAdminIds = user.role === "admin"
          ? []
          : await storage.getWorkspaceAdminIds(user.id);
        res.json({ id: user.id, username: user.username, name: user.name, role: user.role, csrfToken: req.session.csrfToken, workspaceAdminIds });
      });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {});
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.session?.userId) return res.json(null);
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.json(null);
    const workspaceAdminIds = user.role === "admin"
      ? []
      : await storage.getWorkspaceAdminIds(user.id);
    const respond = () => res.json({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      csrfToken: req.session.csrfToken,
      workspaceAdminIds,
    });
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomUUID();
      req.session.save(() => respond());
    } else {
      respond();
    }
  });

  app.get("/api/auth/my-workspaces", requireAuth, async (req, res) => {
    const workspaces = await storage.getUserWorkspaces(req.session.userId!);
    res.json(workspaces);
  });

  app.get("/api/auth/my-admin-workspaces", requireAuth, async (req, res) => {
    const workspaces = await storage.getAdminWorkspaces(req.session.userId!);
    res.json(workspaces);
  });

  // ── Global auth guard (after public routes above) ─────────────────────────
  app.use("/api", (req, res, next) => {
    const isPublic =
      req.path.startsWith("/auth/") ||
      /^\/channels\/[^/]+\/webhook$/.test(req.path) ||
      /^\/channels\/[^/]+\/slack\/events$/.test(req.path) ||
      /^\/channels\/[^/]+\/teams\/events$/.test(req.path);
    if (isPublic) return next();
    return requireAuth(req, res, next);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const taskSubscribers = new Map<string, Set<WebSocket>>();

  wss.on("connection", (ws) => {
    let subscribedTaskId: string | null = null;

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "subscribe" && data.taskId) {
          subscribedTaskId = data.taskId;
          if (!taskSubscribers.has(data.taskId)) {
            taskSubscribers.set(data.taskId, new Set());
          }
          taskSubscribers.get(data.taskId)!.add(ws);
          ws.send(JSON.stringify({ type: "subscribed", taskId: data.taskId }));
        }
      } catch {}
    });

    ws.on("close", () => {
      if (subscribedTaskId) {
        taskSubscribers.get(subscribedTaskId)?.delete(ws);
      }
    });
  });

  taskLogEmitter.on("task:*", function (this: string, log: unknown) {
    const taskId = this.replace("task:", "");
    const subscribers = taskSubscribers.get(taskId);
    if (!subscribers) return;
    const msg = JSON.stringify({ type: "log", data: log });
    for (const ws of Array.from(subscribers)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  });

  app.get("/api/providers/models", (_req, res) => {
    res.json(PROVIDER_MODELS);
  });

  app.get("/api/workspaces", requireAuth, async (_req, res) => {
    const ws = await storage.listWorkspaces();
    res.json(ws);
  });

  app.post("/api/workspaces", requireAdmin, async (req, res) => {
    const parsed = insertWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const ws = await storage.createWorkspace(parsed.data);
    res.status(201).json(ws);
  });

  app.get("/api/workspaces/:id", requireAuth, async (req, res) => {
    const ws = await storage.getWorkspace(req.params.id as string);
    if (!ws) return res.status(404).json({ error: "Not found" });
    res.json(ws);
  });

  app.put("/api/workspaces/:id", requireAdmin, async (req, res) => {
    const ws = await storage.updateWorkspace(req.params.id as string, req.body);
    res.json(ws);
  });

  app.delete("/api/workspaces/:id", requireAdmin, async (req, res) => {
    await storage.deleteWorkspace(req.params.id as string);
    res.status(204).send();
  });

  // ── Workspace config (limits) ──────────────────────────────────────────────

  app.get("/api/workspaces/:id/config", requireWorkspaceAdmin, async (req, res) => {
    const cfg = await storage.getWorkspaceConfig(req.params.id as string);
    res.json(cfg ?? { workspaceId: req.params.id as string });
  });

  app.put("/api/workspaces/:id/config", requireAdmin, async (req, res) => {
    const { maxOrchestrators, maxAgents, maxChannels, maxScheduledJobs,
            allowedAiProviders, allowedCloudProviders, allowedChannelTypes } = req.body;
    const cfg = await storage.upsertWorkspaceConfig(req.params.id as string, {
      maxOrchestrators: maxOrchestrators ?? null,
      maxAgents: maxAgents ?? null,
      maxChannels: maxChannels ?? null,
      maxScheduledJobs: maxScheduledJobs ?? null,
      allowedAiProviders: allowedAiProviders ?? null,
      allowedCloudProviders: allowedCloudProviders ?? null,
      allowedChannelTypes: allowedChannelTypes ?? null,
    });
    res.json(cfg);
  });

  app.get("/api/workspaces/:id/quota", requireWorkspaceAdmin, async (req, res) => {
    const workspaceId = req.params.id as string;
    const [cfg, orchestrators, agents, channels, scheduledJobs] = await Promise.all([
      storage.getWorkspaceConfig(workspaceId),
      storage.countOrchestrators(workspaceId),
      storage.countAgentsInWorkspace(workspaceId),
      storage.countChannelsInWorkspace(workspaceId),
      storage.countScheduledJobsInWorkspace(workspaceId),
    ]);
    res.json({
      config: cfg ?? null,
      counts: { orchestrators, agents, channels, scheduledJobs },
    });
  });

  app.get("/api/workspaces/:id/orchestrators", requireAuth, async (req, res) => {
    const orchs = await storage.listOrchestrators(req.params.id as string);
    res.json(orchs);
  });

  app.post("/api/workspaces/:id/orchestrators", requireWorkspaceAdmin, async (req, res) => {
    const parsed = insertOrchestratorSchema.safeParse({ ...req.body, workspaceId: req.params.id as string });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const cfg = await storage.getWorkspaceConfig(req.params.id as string);
    if (cfg?.maxOrchestrators != null) {
      const count = await storage.countOrchestrators(req.params.id as string);
      if (count >= cfg.maxOrchestrators)
        return res.status(409).json({ error: `Workspace limit reached: max ${cfg.maxOrchestrators} orchestrator(s) allowed.` });
    }
    if (cfg?.allowedAiProviders != null && !cfg.allowedAiProviders.includes(parsed.data.provider as string)) {
      return res.status(403).json({ error: `AI provider "${parsed.data.provider}" is not allowed in this workspace.` });
    }
    const orch = await storage.createOrchestrator(parsed.data);
    res.status(201).json(orch);
  });

  app.get("/api/orchestrators/:id", requireAuth, async (req, res) => {
    const orch = await storage.getOrchestrator(req.params.id as string);
    if (!orch) return res.status(404).json({ error: "Not found" });
    res.json(orch);
  });

  app.put("/api/orchestrators/:id", requireAuth, async (req, res) => {
    const orch = await storage.updateOrchestrator(req.params.id as string, req.body);
    res.json(orch);
  });

  app.delete("/api/orchestrators/:id", requireAuth, async (req, res) => {
    await storage.deleteOrchestrator(req.params.id as string);
    res.status(204).send();
  });

  app.get("/api/orchestrators/:id/agents", requireAuth, async (req, res) => {
    const agentList = await storage.listAgents(req.params.id as string);
    res.json(agentList);
  });

  app.post("/api/orchestrators/:id/agents", requireAuth, async (req, res) => {
    const parsed = insertAgentSchema.safeParse({ ...req.body, orchestratorId: req.params.id as string });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const orch = await storage.getOrchestrator(req.params.id as string);
    if (orch) {
      const wsId = orch.workspaceId as string;
      const cfg = await storage.getWorkspaceConfig(wsId);
      if (cfg?.maxAgents != null) {
        const count = await storage.countAgentsInWorkspace(wsId);
        if (count >= cfg.maxAgents)
          return res.status(409).json({ error: `Workspace limit reached: max ${cfg.maxAgents} agent(s) allowed.` });
      }
    }
    const agent = await storage.createAgent(parsed.data);
    res.status(201).json(agent);
  });

  app.get("/api/agents/:id", requireAuth, async (req, res) => {
    const agent = await storage.getAgent(req.params.id as string);
    if (!agent) return res.status(404).json({ error: "Not found" });
    res.json(agent);
  });

  app.put("/api/agents/:id", requireAuth, async (req, res) => {
    const parsed = insertAgentSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const agent = await storage.updateAgent(req.params.id as string, parsed.data);
    res.json(agent);
  });

  app.delete("/api/agents/:id", requireAuth, async (req, res) => {
    await storage.deleteAgent(req.params.id as string);
    res.status(204).send();
  });

  app.get("/api/orchestrators/:id/channels", requireAuth, async (req, res) => {
    const chList = await storage.listChannels(req.params.id as string);
    res.json(chList);
  });

  app.post("/api/orchestrators/:id/channels", requireAuth, async (req, res) => {
    const parsed = insertChannelSchema.safeParse({ ...req.body, orchestratorId: req.params.id as string });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const orch = await storage.getOrchestrator(req.params.id as string);
    if (orch) {
      const wsId = orch.workspaceId as string;
      const cfg = await storage.getWorkspaceConfig(wsId);
      if (cfg?.maxChannels != null) {
        const count = await storage.countChannelsInWorkspace(wsId);
        if (count >= cfg.maxChannels)
          return res.status(409).json({ error: `Workspace limit reached: max ${cfg.maxChannels} channel(s) allowed.` });
      }
      if (cfg?.allowedChannelTypes != null && !cfg.allowedChannelTypes.includes(parsed.data.type as string)) {
        return res.status(403).json({ error: `Channel type "${parsed.data.type}" is not allowed in this workspace.` });
      }
    }
    const ch = await storage.createChannel(parsed.data);
    res.status(201).json(ch);
  });

  app.get("/api/channels/:id", requireAuth, async (req, res) => {
    const ch = await storage.getChannel(req.params.id as string);
    if (!ch) return res.status(404).json({ error: "Not found" });
    res.json(ch);
  });

  app.put("/api/channels/:id", requireAuth, async (req, res) => {
    const ch = await storage.updateChannel(req.params.id as string, req.body);
    res.json(ch);
  });

  app.delete("/api/channels/:id", requireAuth, async (req, res) => {
    await storage.deleteChannel(req.params.id as string);
    res.status(204).send();
  });

  app.post("/api/channels/:id/slack/events", webhookLimiter, async (req, res) => {
    await handleSlackEvent(req.params.id as string, req, res);
  });

  app.post("/api/channels/:id/teams/events", webhookLimiter, async (req, res) => {
    await handleTeamsEvent(req.params.id as string, req, res);
  });

  app.post("/api/channels/:id/webhook", webhookLimiter, async (req, res) => {
    const ch = await storage.getChannel((req.params.id as string));
    if (!ch || !ch.isActive) return res.status(404).json({ error: "Channel not found or inactive" });
    const apiKey = req.headers["x-api-key"] as string;
    if (ch.apiKey && apiKey !== ch.apiKey) return res.status(401).json({ error: "Invalid API key" });

    const input = req.body?.input ?? JSON.stringify(req.body);
    const orch = await storage.getOrchestrator(ch.orchestratorId);
    if (!orch) return res.status(404).json({ error: "Orchestrator not found" });

    const agents = await storage.listAgents(orch.id);
    const task = await storage.createTask({
      orchestratorId: orch.id,
      agentId: agents[0]?.id ?? null,
      channelId: ch.id,
      input,
      status: "pending",
      priority: 5,
    });
    res.json({ taskId: task.id, status: "queued" });
  });

  app.get("/api/orchestrators/:id/tasks", requireAuth, async (req, res) => {
    const taskList = await storage.listTasks(req.params.id as string, 100);
    res.json(taskList);
  });

  app.post("/api/orchestrators/:id/tasks", requireAuth, async (req, res) => {
    const orch = await storage.getOrchestrator(req.params.id as string);
    if (!orch) return res.status(404).json({ error: "Orchestrator not found" });
    const { input, agentId } = req.body;
    if (!input) return res.status(400).json({ error: "input is required" });

    const task = await storage.createTask({
      orchestratorId: req.params.id as string,
      agentId: agentId ?? null,
      channelId: null,
      input,
      status: "pending",
      priority: req.body.priority ?? 5,
    });
    res.status(201).json(task);
  });

  app.get("/api/tasks/:id", requireAuth, async (req, res) => {
    const task = await storage.getTask(req.params.id as string);
    if (!task) return res.status(404).json({ error: "Not found" });
    res.json(task);
  });

  app.get("/api/tasks/:id/logs", requireAuth, async (req, res) => {
    const logs = await storage.listTaskLogs(req.params.id as string);
    res.json(logs);
  });

  app.get("/api/tasks/:id/stream", async (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendLog = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const existingLogs = await storage.listTaskLogs(taskId);
    for (const log of existingLogs) {
      sendLog(log);
    }

    const task = await storage.getTask(taskId);
    if (task?.status === "completed" || task?.status === "failed") {
      res.write(`data: ${JSON.stringify({ type: "done", status: task.status })}\n\n`);
      res.end();
      return;
    }

    const logHandler = (log: unknown) => sendLog(log);
    taskLogEmitter.on(`task:${taskId}`, logHandler);

    req.on("close", () => {
      taskLogEmitter.off(`task:${taskId}`, logHandler);
    });
  });

  app.get("/api/stats", requireAuth, async (_req, res) => {
    const allTasks = await storage.listAllTasks(1000);
    const completed = allTasks.filter((t) => t.status === "completed").length;
    const failed = allTasks.filter((t) => t.status === "failed").length;
    const running = allTasks.filter((t) => t.status === "running").length;
    const pending = allTasks.filter((t) => t.status === "pending").length;
    res.json({ total: allTasks.length, completed, failed, running, pending });
  });

  app.get("/api/workspaces/:id/integrations", requireWorkspaceAdmin, async (req, res) => {
    const list = await storage.listCloudIntegrations(req.params.id as string);
    const safe = list.map(({ credentialsEncrypted, ...rest }) => {
      let credentialsMeta: Record<string, string> = {};
      try {
        const raw = JSON.parse(decrypt(credentialsEncrypted));
        if (rest.provider === "jira" && raw.tokenType) credentialsMeta.tokenType = raw.tokenType;
      } catch {}
      return { ...rest, credentialsMeta };
    });
    res.json(safe);
  });

  app.post("/api/workspaces/:id/integrations", requireWorkspaceAdmin, async (req, res) => {
    const { name, provider, credentials, scopes, integrationMode } = req.body;
    if (!name || !provider || !credentials) {
      return res.status(400).json({ error: "name, provider, and credentials are required" });
    }
    const cfg = await storage.getWorkspaceConfig(req.params.id as string);
    if (cfg?.allowedCloudProviders != null && !cfg.allowedCloudProviders.includes(provider)) {
      return res.status(403).json({ error: `Integration provider "${provider}" is not allowed in this workspace.` });
    }
    const credStr = typeof credentials === "string" ? credentials : JSON.stringify(credentials);
    const credentialsEncrypted = encrypt(credStr);
    const ci = await storage.createCloudIntegration({
      workspaceId: req.params.id as string,
      name,
      provider,
      integrationMode: integrationMode ?? "tool",
      credentialsEncrypted,
      scopes: scopes ?? [],
      isActive: true,
    });
    const { credentialsEncrypted: _, ...safe } = ci;
    res.status(201).json(safe);
  });

  app.get("/api/integrations/:id", requireAuth, async (req, res) => {
    const ci = await storage.getCloudIntegration(req.params.id as string);
    if (!ci) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, ci.workspaceId)) return;
    const { credentialsEncrypted: _, ...safe } = ci;
    res.json(safe);
  });

  app.put("/api/integrations/:id", requireAuth, async (req, res) => {
    const existing = await storage.getCloudIntegration(req.params.id as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, existing.workspaceId)) return;

    const { credentials, ...rest } = req.body;
    const updateData: Record<string, unknown> = { ...rest };

    if (credentials !== undefined) {
      const incoming: Record<string, string> = typeof credentials === "string" ? JSON.parse(credentials) : credentials;

      if (existing.provider === "gcp") {
        // GCP stores the service account JSON directly — only replace if a new value was supplied
        const newJson = incoming?.serviceAccountJson?.trim();
        if (newJson) {
          try {
            updateData.credentialsEncrypted = encrypt(JSON.stringify(JSON.parse(newJson)));
          } catch {
            updateData.credentialsEncrypted = encrypt(newJson);
          }
        }
        // blank serviceAccountJson → leave existing credentials unchanged
      } else {
        // All other providers: decrypt existing, merge in any non-blank incoming fields
        const existingRaw: Record<string, string> = JSON.parse(decrypt(existing.credentialsEncrypted));
        const merged = { ...existingRaw };
        for (const [k, v] of Object.entries(incoming)) {
          if (typeof v === "string" && v.trim()) merged[k] = v.trim();
        }
        updateData.credentialsEncrypted = encrypt(JSON.stringify(merged));
      }
    }

    const ci = await storage.updateCloudIntegration(req.params.id as string, updateData as any);
    const { credentialsEncrypted: _, ...safe } = ci;
    res.json(safe);
  });

  app.delete("/api/integrations/:id", requireAuth, async (req, res) => {
    const ci = await storage.getCloudIntegration(req.params.id as string);
    if (!ci) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, ci.workspaceId)) return;
    await storage.deleteCloudIntegration(req.params.id as string);
    res.status(204).send();
  });

  app.post("/api/integrations/:id/test", requireAuth, async (req, res) => {
    const ci = await storage.getCloudIntegration(req.params.id as string);
    if (!ci) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, ci.workspaceId)) return;

    try {
      const decrypted = decrypt(ci.credentialsEncrypted);
      const raw = JSON.parse(decrypted);

      let creds: Parameters<typeof validateCredentials>[0];
      if (ci.provider === "aws") {
        creds = { provider: "aws", credentials: { accessKeyId: raw.accessKeyId, secretAccessKey: raw.secretAccessKey, region: raw.region } };
      } else if (ci.provider === "gcp") {
        creds = { provider: "gcp", credentials: { serviceAccountJson: raw } };
      } else if (ci.provider === "ragflow") {
        creds = { provider: "ragflow", credentials: { baseUrl: raw.baseUrl, apiKey: raw.apiKey } };
      } else if (ci.provider === "jira") {
        creds = { provider: "jira", credentials: { baseUrl: raw.baseUrl, email: raw.email, apiToken: raw.apiToken, defaultProjectKey: raw.defaultProjectKey, tokenType: raw.tokenType } };
      } else if (ci.provider === "github") {
        creds = { provider: "github", credentials: { token: raw.token, defaultOwner: raw.defaultOwner } };
      } else if (ci.provider === "gitlab") {
        creds = { provider: "gitlab", credentials: { baseUrl: raw.baseUrl, token: raw.token, defaultProjectId: raw.defaultProjectId } };
      } else if (ci.provider === "teams") {
        creds = { provider: "teams", credentials: { webhookUrl: raw.webhookUrl } };
      } else {
        creds = { provider: "azure", credentials: { clientId: raw.clientId, clientSecret: raw.clientSecret, tenantId: raw.tenantId, subscriptionId: raw.subscriptionId } };
      }

      const result = await validateCredentials(creds);
      res.json(result);
    } catch (err: any) {
      res.json({ ok: false, detail: err?.message ?? String(err) });
    }
  });

  // ── Chat ────────────────────────────────────────────────────────────────────

  app.get("/api/workspaces/:id/agents", requireAuth, async (req, res) => {
    const agents = await storage.listAgentsForWorkspace(req.params.id as string);
    res.json(agents);
  });

  app.get("/api/workspaces/:id/stats", requireAuth, async (req, res) => {
    const stats = await storage.getWorkspaceStats(req.params.id as string);
    res.json(stats);
  });

  app.get("/api/workspaces/:id/conversations", requireAuth, async (req, res) => {
    const convs = await storage.listChatConversations(req.params.id as string);
    res.json(convs);
  });

  app.post("/api/workspaces/:id/conversations", requireAuth, async (req, res) => {
    const { title } = req.body;
    const conv = await storage.createChatConversation({ workspaceId: req.params.id as string, title: title ?? "New Chat" });
    res.status(201).json(conv);
  });

  app.patch("/api/conversations/:id", requireAuth, async (req, res) => {
    const { title } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    const conv = await storage.updateChatConversation(req.params.id as string, title.trim());
    res.json(conv);
  });

  app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
    await storage.deleteChatConversation(req.params.id as string);
    res.status(204).send();
  });

  app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
    const messages = await storage.listChatMessages(req.params.id as string);
    res.json(messages);
  });

  app.get("/api/workspaces/:id/default-conversation", requireAuth, async (req, res) => {
    const conv = await storage.getOrCreateDefaultConversation(req.params.id as string);
    res.json(conv);
  });

  app.post("/api/conversations/:id/chat", requireAuth, async (req, res) => {
    const { content, mentionedAgentIds } = req.body as { content: string; mentionedAgentIds: string[] };
    if (!content?.trim()) return res.status(400).json({ error: "content required" });

    const conv = await storage.getChatConversation(req.params.id as string);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const userMsg = await storage.createChatMessage({
      conversationId: req.params.id as string,
      role: "user",
      content: content.trim(),
      mentions: mentionedAgentIds ?? [],
    });

    // Auto-generate a meaningful title on the first message if still using a generic name
    const genericTitles = ["new chat", "general"];
    if (genericTitles.includes(conv.title.toLowerCase())) {
      generateChatTitle(content.trim())
        .then((title) => storage.updateChatConversation(req.params.id as string, title))
        .catch(() => {/* silent — title stays as-is */});
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ type: "user_message", message: userMsg });

    if (!mentionedAgentIds?.length) {
      send({ type: "done" });
      res.end();
      return;
    }

    const allIntegrations = await storage.getCloudIntegrationsForWorkspace(conv.workspaceId);
    const toolIntegrations = allIntegrations.filter((ci) => ci.integrationMode !== "context");
    const contextIntegrations = allIntegrations.filter((ci) => ci.integrationMode === "context");
    const hasCloud = toolIntegrations.length > 0;

    const history = await storage.listChatMessages(req.params.id as string);
    const contextMessages = history.slice(-20).map((m) => ({
      role: m.role === "user" ? "user" as const : "assistant" as const,
      content: m.content,
    }));

    for (const agentId of mentionedAgentIds) {
      try {
        const agentsWithMeta = await storage.listAgentsForWorkspace(conv.workspaceId);
        const agentMeta = agentsWithMeta.find((a) => a.id === agentId);
        if (!agentMeta) {
          send({ type: "agent_error", agentId, error: "Agent not found" });
          continue;
        }

        const intent = await classifyIntent(content.trim(), agentMeta.provider, agentMeta.model, agentMeta.baseUrl);
        const bypass = hasApprovalBypass(content.trim());

        if (intent === "action" && hasCloud && !bypass) {
          // Build tool list for preflight — no credential decryption needed, just provider lookup
          const agentEnabledToolNames: string[] = Array.isArray(agentMeta.tools) ? agentMeta.tools as string[] : [];
          const availableForPreflight: ToolDefinition[] = [];
          for (const ci of toolIntegrations) {
            if (ci.isActive) availableForPreflight.push(...getToolsForProvider(ci.provider as any));
          }
          const filteredForPreflight = agentEnabledToolNames.length > 0
            ? availableForPreflight.filter((t) => agentEnabledToolNames.includes(t.name))
            : availableForPreflight;

          const preflight = await runPreflightAnalysis(
            content.trim(),
            filteredForPreflight,
            agentMeta.provider,
            agentMeta.model,
            agentMeta.baseUrl
          );

          const confirmMsg = await storage.createChatMessage({
            conversationId: req.params.id as string,
            role: "system",
            agentId,
            agentName: agentMeta.name,
            content: `**${agentMeta.name}** wants to perform a cloud action.`,
            messageType: "pending_confirmation",
            metadata: {
              agentId,
              agentName: agentMeta.name,
              proposedAction: content.trim(),
              status: "pending",
              preflight: preflight ?? null,
            },
          });
          send({ type: "confirmation", message: confirmMsg });
        } else {
          send({ type: "agent_start", agentId, agentName: agentMeta.name, bypassed: bypass && intent === "action" && hasCloud });

          const systemPrompt = agentMeta.instructions || "You are a helpful AI assistant.";
          const agentEnabledTools: string[] = Array.isArray(agentMeta.tools)
            ? (agentMeta.tools as string[]) : [];

          // Auto-retrieve context-mode RAGFlow chunks — only for conversational intent.
          // Citations are exclusive to RAGFlow / conversational responses; never inject
          // knowledge-base context into cloud-action or code-execution agent prompts.
          const collectedContextSources: Array<{ content: string; documentName: string; score: number }> = [];
          if (intent === "conversational") {
            for (const ci of contextIntegrations) {
              if (!ci.isActive || ci.provider !== "ragflow") continue;
              try {
                const raw = JSON.parse(decrypt(ci.credentialsEncrypted));
                const chunks = await retrieveRAGFlowContext(content.trim(), { baseUrl: raw.baseUrl, apiKey: raw.apiKey });
                collectedContextSources.push(...chunks);
              } catch { /* skip unavailable context integrations */ }
            }
          }

          // Load tool-mode credentials for the workspace
          const loadedCreds: Array<{ provider: string; credentials: any; integrationId: string }> = [];
          for (const ci of toolIntegrations) {
            try {
              const raw = JSON.parse(decrypt(ci.credentialsEncrypted));
              if (ci.provider === "aws") {
                loadedCreds.push({ integrationId: ci.id, provider: "aws", credentials: { accessKeyId: raw.accessKeyId, secretAccessKey: raw.secretAccessKey, region: raw.region } });
              } else if (ci.provider === "gcp") {
                loadedCreds.push({ integrationId: ci.id, provider: "gcp", credentials: { serviceAccountJson: raw } });
              } else if (ci.provider === "azure") {
                loadedCreds.push({ integrationId: ci.id, provider: "azure", credentials: { clientId: raw.clientId, clientSecret: raw.clientSecret, tenantId: raw.tenantId, subscriptionId: raw.subscriptionId } });
              } else if (ci.provider === "ragflow") {
                loadedCreds.push({ integrationId: ci.id, provider: "ragflow", credentials: { baseUrl: raw.baseUrl, apiKey: raw.apiKey } });
              } else if (ci.provider === "jira") {
                loadedCreds.push({ integrationId: ci.id, provider: "jira", credentials: { baseUrl: raw.baseUrl, email: raw.email, apiToken: raw.apiToken, defaultProjectKey: raw.defaultProjectKey, tokenType: raw.tokenType } });
              } else if (ci.provider === "github") {
                loadedCreds.push({ integrationId: ci.id, provider: "github", credentials: { token: raw.token, defaultOwner: raw.defaultOwner } });
              } else if (ci.provider === "gitlab") {
                loadedCreds.push({ integrationId: ci.id, provider: "gitlab", credentials: { baseUrl: raw.baseUrl, token: raw.token, defaultProjectId: raw.defaultProjectId } });
              } else if (ci.provider === "teams") {
                loadedCreds.push({ integrationId: ci.id, provider: "teams", credentials: { webhookUrl: raw.webhookUrl } });
              }
            } catch { /* skip bad creds */ }
          }

          // Build tool list filtered to agent-enabled tools
          const allAvailable: ToolDefinition[] = [];
          for (const cred of loadedCreds) {
            allAvailable.push(...getToolsForProvider(cred.provider as any));
          }
          let agentTools = agentEnabledTools.length > 0
            ? allAvailable.filter((t) => agentEnabledTools.includes(t.name))
            : [];

          // Inject code_interpreter for code_execution intent — runCode handles Docker → local fallback
          if (intent === "code_execution") {
            agentTools = [CODE_INTERPRETER_TOOL, ...agentTools];
          }

          // Collect RAGFlow sources from tool results + pre-fetched context sources
          const collectedSources: Array<{ content: string; documentName: string; score: number; datasetId?: string }> = [
            ...collectedContextSources,
          ];

          // Enrich system prompt with context-mode retrieved chunks
          let effectiveSystemPrompt = systemPrompt;
          if (collectedContextSources.length > 0) {
            const contextBlock = collectedContextSources
              .map((c, i) => `[${i + 1}] ${c.documentName ? `(${c.documentName}) ` : ""}${c.content}`)
              .join("\n\n");
            effectiveSystemPrompt = `${systemPrompt}\n\n---\nRelevant knowledge base context (cite sources in your answer):\n${contextBlock}\n---`;
          }

          // Inject available agents roster + SPAWN_AGENT_TOOL for parallel delegation
          const otherAgents = agentsWithMeta.filter((a) => a.id !== agentId);
          if (otherAgents.length > 0) {
            const rosterLines = otherAgents
              .map((a) => `- "${a.name}" (agentId: ${a.id})${a.description ? " — " + a.description : ""}`)
              .join("\n");
            effectiveSystemPrompt +=
              `\n\nYou can delegate specific subtasks to specialist agents in parallel using the spawn_agent tool. ` +
              `All spawn_agent calls in the same response execute concurrently. ` +
              `Available agents:\n${rosterLines}`;
            agentTools = [...agentTools, SPAWN_AGENT_TOOL];
          }

          let accumulated = "";
          const msgs = [...contextMessages];

          if (agentTools.length === 0) {
            // Simple streaming, no tools
            await runAgent({
              provider: agentMeta.provider as any,
              model: agentMeta.model,
              baseUrl: agentMeta.baseUrl,
              systemPrompt: effectiveSystemPrompt,
              messages: msgs,
              maxTokens: agentMeta.maxTokens ?? 4096,
              temperature: agentMeta.temperature ?? 70,
              onChunk: (chunk) => {
                accumulated += chunk;
                send({ type: "chunk", agentId, content: chunk });
              },
            });
          } else {
            // Tool-call loop
            const MAX_ROUNDS = 5;
            let done = false;
            let toolRounds = 0;

            while (!done && toolRounds < MAX_ROUNDS) {
              const result = await runAgent({
                provider: agentMeta.provider as any,
                model: agentMeta.model,
                baseUrl: agentMeta.baseUrl,
                systemPrompt: effectiveSystemPrompt,
                messages: msgs,
                maxTokens: agentMeta.maxTokens ?? 4096,
                temperature: agentMeta.temperature ?? 70,
                tools: agentTools,
              });

              if (!result.toolCalls || result.toolCalls.length === 0) {
                accumulated = result.content;
                send({ type: "chunk", agentId, content: result.content });
                done = true;
                break;
              }

              if (result.content) {
                msgs.push({ role: "assistant", content: result.content });
              }

              const spawnCalls = result.toolCalls.filter((tc) => tc.name === "spawn_agent");
              const regularCalls = result.toolCalls.filter((tc) => tc.name !== "spawn_agent");

              for (const toolCall of regularCalls) {
                if (toolCall.name === "code_interpreter") {
                  const { language, code } = toolCall.arguments as { language: string; code: string };
                  send({ type: "code_running", agentId, language });
                  try {
                    const sandboxTimeout = agentMeta.sandboxTimeoutSeconds ?? undefined;
                    const sandboxResult = await runCode(language, code, sandboxTimeout);
                    const output = sandboxResult.exitCode === 0
                      ? `exit_code: 0\nstdout:\n${sandboxResult.stdout || "(no output)"}`
                      : `exit_code: ${sandboxResult.exitCode}\nstdout:\n${sandboxResult.stdout || "(no output)"}\nstderr:\n${sandboxResult.stderr || "(none)"}`;
                    msgs.push({ role: "user", content: `Tool code_interpreter result:\n${output}` });
                  } catch (err: any) {
                    msgs.push({ role: "user", content: `Tool code_interpreter result: ERROR — ${err?.message ?? String(err)}` });
                  }
                  continue;
                }

                const provider = detectProviderFromToolName(toolCall.name);
                const cred = loadedCreds.find((c) => c.provider === provider);

                if (!cred) {
                  msgs.push({ role: "user", content: `Tool ${toolCall.name} result: ERROR — No ${provider} integration configured` });
                  continue;
                }

                try {
                  send({ type: "tool_call", agentId, toolName: toolCall.name });
                  const toolResult = await executeCloudTool(toolCall.name, toolCall.arguments, cred as any);

                  // Capture RAGFlow sources — only for conversational intent.
                  // Cloud-action responses must never carry knowledge-base citations.
                  if (intent === "conversational" && toolCall.name.startsWith("ragflow_query") && toolResult && typeof toolResult === "object") {
                    const tr = toolResult as any;
                    if (Array.isArray(tr.chunks)) {
                      for (const chunk of tr.chunks) {
                        collectedSources.push({
                          content: chunk.content ?? "",
                          documentName: chunk.documentName ?? "",
                          score: typeof chunk.score === "number" ? chunk.score : 0,
                          datasetId: chunk.datasetId,
                        });
                      }
                    }
                  }

                  msgs.push({ role: "user", content: `Tool ${toolCall.name} result:\n${JSON.stringify(toolResult, null, 2)}` });
                } catch (err: any) {
                  msgs.push({ role: "user", content: `Tool ${toolCall.name} result: ERROR — ${err.message}` });
                }
              }

              // Run all spawn_agent calls in parallel
              if (spawnCalls.length > 0) {
                const subtaskResults = await Promise.all(
                  spawnCalls.map(async (call) => {
                    const {
                      agentId: subtaskAgentId,
                      agentName: subtaskAgentNameArg,
                      prompt: subtaskPrompt,
                    } = call.arguments as { agentId: string; agentName?: string; prompt: string };
                    const subtaskId = `st-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                    const subtaskMeta = agentsWithMeta.find((a) => a.id === subtaskAgentId);
                    const subtaskAgentName = subtaskAgentNameArg ?? subtaskMeta?.name ?? subtaskAgentId;

                    send({ type: "subtask_start", subtaskId, agentId: subtaskAgentId, agentName: subtaskAgentName, prompt: subtaskPrompt });

                    try {
                      const output = await runSubtaskAgent({
                        agentId: subtaskAgentId,
                        prompt: subtaskPrompt,
                        subtaskId,
                        loadedCreds,
                        allWorkspaceAgents: agentsWithMeta,
                        send,
                      });
                      send({ type: "subtask_done", subtaskId, agentName: subtaskAgentName, output });
                      return `[${subtaskAgentName}]: ${output}`;
                    } catch (err: any) {
                      const errMsg = err?.message ?? String(err);
                      send({ type: "subtask_error", subtaskId, agentName: subtaskAgentName, error: errMsg });
                      return `[${subtaskAgentName}]: ERROR — ${errMsg}`;
                    }
                  })
                );
                msgs.push({
                  role: "user",
                  content: `Parallel subtask results:\n\n${subtaskResults.join("\n\n---\n\n")}`,
                });
              }

              toolRounds++;
            }

            if (!done) {
              const finalResult = await runAgent({
                provider: agentMeta.provider as any,
                model: agentMeta.model,
                baseUrl: agentMeta.baseUrl,
                systemPrompt: effectiveSystemPrompt,
                messages: [...msgs, { role: "user", content: "Please provide your final answer based on the tool results above." }],
                maxTokens: agentMeta.maxTokens ?? 4096,
                temperature: agentMeta.temperature ?? 70,
                onChunk: (chunk) => {
                  accumulated += chunk;
                  send({ type: "chunk", agentId, content: chunk });
                },
              });
              accumulated = finalResult.content;
            }
          }

          const agentMsg = await storage.createChatMessage({
            conversationId: req.params.id as string,
            role: "agent",
            agentId,
            agentName: agentMeta.name,
            content: accumulated,
            metadata: collectedSources.length > 0 ? { sources: collectedSources } : {},
          });

          send({ type: "agent_done", agentId, agentName: agentMeta.name, messageId: agentMsg.id, metadata: agentMsg.metadata ?? {} });
        }
      } catch (err: any) {
        send({ type: "agent_error", agentId, error: err?.message ?? String(err) });
      }
    }

    send({ type: "done" });
    res.end();
  });

  app.post("/api/conversations/:convId/messages/:msgId/confirm", requireAuth, async (req, res) => {
    const { approved } = req.body as { approved: boolean };
    const { convId, msgId } = req.params as { convId: string; msgId: string };

    const message = await storage.getChatMessage(msgId);
    if (!message || message.messageType !== "pending_confirmation") {
      return res.status(404).json({ error: "Confirmation message not found" });
    }

    if (!approved) {
      await storage.updateChatMessage(msgId, {
        metadata: { ...(message.metadata as Record<string, unknown>), status: "cancelled" },
      });
      return res.json({ status: "cancelled" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const meta = message.metadata as Record<string, unknown>;
    const agentId = meta.agentId as string;
    const proposedAction = meta.proposedAction as string;

    await storage.updateChatMessage(msgId, {
      metadata: { ...meta, status: "running" },
    });
    send({ type: "confirmed" });

    const agentRecord = await storage.getAgent(agentId);
    if (!agentRecord) {
      send({ type: "error", error: "Agent not found" });
      res.end();
      return;
    }

    const task = await storage.createTask({
      orchestratorId: agentRecord.orchestratorId,
      agentId,
      input: proposedAction,
      priority: 5,
      intent: "action",
    });

    await storage.updateChatMessage(msgId, {
      metadata: { ...meta, status: "running", taskId: task.id },
    });
    send({ type: "task_started", taskId: task.id });

    const logHandler = (entry: { level: string; message: string }) => {
      send({ type: "task_log", level: entry.level, message: entry.message });
    };
    const streamHandler = (chunk: string) => {
      send({ type: "chunk", content: chunk });
    };

    taskLogEmitter.on(`task:${task.id}`, logHandler);
    taskLogEmitter.on(`task:${task.id}:stream`, streamHandler);

    try {
      await executeTask(task.id);
    } catch (_) {
    }

    taskLogEmitter.off(`task:${task.id}`, logHandler);
    taskLogEmitter.off(`task:${task.id}:stream`, streamHandler);

    const completedTask = await storage.getTask(task.id);
    const succeeded = completedTask?.status === "completed";
    const resultContent = succeeded
      ? (completedTask!.output ?? "Task completed with no output.")
      : `Task failed: ${completedTask?.errorMessage ?? "Unknown error"}`;

    const resultMsg = await storage.createChatMessage({
      conversationId: convId,
      role: "agent",
      agentId,
      agentName: meta.agentName as string,
      content: resultContent,
      messageType: "task_result",
      metadata: { taskId: task.id },
    });

    await storage.updateChatMessage(msgId, {
      metadata: { ...meta, status: succeeded ? "completed" : "failed", taskId: task.id },
    });

    send({ type: "done", resultMessage: resultMsg });
    res.end();
  });

  // ── Workspace by slug ─────────────────────────────────────────────────────
  app.get("/api/workspaces/by-slug/:slug", requireAuth, async (req, res) => {
    const ws = await storage.getWorkspaceBySlug((req.params.slug as string));
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    res.json(ws);
  });

  // ── Workspace-scoped admin helper ─────────────────────────────────────────
  // Returns true if the caller is a global admin or workspace admin for the
  // given workspaceId. Use for resource-level routes that lack workspaceId in
  // their URL path (pipelines/:id, scheduled-jobs/:id, approvals/:id, etc.).
  async function assertWorkspaceAdmin(req: Request, res: Response, workspaceId: string): Promise<boolean> {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    if (req.session.userRole === "admin") return true;
    const ok = await storage.isWorkspaceAdminMember(workspaceId, req.session.userId!);
    if (!ok) {
      res.status(403).json({ error: "Forbidden — workspace admin access required" });
      return false;
    }
    return true;
  }

  // ── Member management ──────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/members", requireWorkspaceAdmin, async (req, res) => {
    const members = await storage.listWorkspaceMembers((req.params.id as string));
    res.json(members);
  });

  app.post("/api/workspaces/:id/members", requireWorkspaceAdmin, async (req, res) => {
    const { username, name, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    let user = await storage.getUserByUsername(username);
    if (!user) {
      user = await storage.createUser({
        username,
        passwordHash: hashPassword(password),
        name: name || username,
        role: "member",
      });
    }
    await storage.addWorkspaceMember((req.params.id as string), user.id, role ?? "member");
    res.json({ ok: true, userId: user.id });
  });

  app.patch("/api/workspaces/:id/members/:userId", requireWorkspaceAdmin, async (req, res) => {
    const { role } = req.body as { role: "admin" | "member" };
    if (!["admin", "member"].includes(role)) {
      return res.status(400).json({ error: "role must be admin or member" });
    }
    await storage.updateWorkspaceMemberRole((req.params.id as string), (req.params.userId as string), role);
    res.json({ ok: true });
  });

  app.delete("/api/workspaces/:id/members/:userId", requireWorkspaceAdmin, async (req, res) => {
    await storage.removeWorkspaceMember((req.params.id as string), (req.params.userId as string));
    res.json({ ok: true });
  });

  // ── Scheduled Jobs ────────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/scheduled-jobs", requireWorkspaceAdmin, async (req, res) => {
    const jobs = await storage.listScheduledJobs((req.params.id as string));
    res.json(jobs);
  });

  app.post("/api/workspaces/:id/scheduled-jobs", requireWorkspaceAdmin, async (req, res) => {
    const parsed = insertScheduledJobSchema.safeParse({ ...req.body, workspaceId: req.params.id as string });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const cfg = await storage.getWorkspaceConfig(req.params.id as string);
    if (cfg?.maxScheduledJobs != null) {
      const count = await storage.countScheduledJobsInWorkspace(req.params.id as string);
      if (count >= cfg.maxScheduledJobs)
        return res.status(409).json({ error: `Workspace limit reached: max ${cfg.maxScheduledJobs} scheduled job(s) allowed.` });
    }
    const { cronExpression, timezone } = parsed.data;
    if (!validateCron(cronExpression)) return res.status(400).json({ message: "Invalid cron expression" });
    const nextRunAt = computeNextRun(cronExpression, timezone ?? "UTC");
    const job = await storage.createScheduledJob({ ...parsed.data, ...(nextRunAt ? { nextRunAt } : {}) });
    registerJob(job);
    res.json(job);
  });

  app.get("/api/scheduled-jobs/:id", requireAuth, async (req, res) => {
    const job = await storage.getScheduledJob((req.params.id as string));
    if (!job) return res.status(404).json({ message: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, job.workspaceId)) return;
    res.json(job);
  });

  app.put("/api/scheduled-jobs/:id", requireAuth, async (req, res) => {
    const existing = await storage.getScheduledJob((req.params.id as string));
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, existing.workspaceId)) return;
    const { cronExpression, timezone, ...rest } = req.body;
    if (cronExpression && !validateCron(cronExpression)) return res.status(400).json({ message: "Invalid cron expression" });
    const effectiveCron = cronExpression ?? existing.cronExpression;
    const effectiveTz = timezone ?? existing.timezone ?? "UTC";
    const nextRunAt = computeNextRun(effectiveCron, effectiveTz);
    const job = await storage.updateScheduledJob((req.params.id as string), {
      ...rest,
      ...(cronExpression ? { cronExpression } : {}),
      ...(timezone ? { timezone } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
    });
    unregisterJob(job.id);
    if (job.isActive) registerJob(job);
    res.json(job);
  });

  app.delete("/api/scheduled-jobs/:id", requireAuth, async (req, res) => {
    const job = await storage.getScheduledJob((req.params.id as string));
    if (!job) return res.status(404).json({ message: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, job.workspaceId)) return;
    unregisterJob((req.params.id as string));
    await storage.deleteScheduledJob((req.params.id as string));
    res.json({ ok: true });
  });

  app.post("/api/channels/:id/test", requireAuth, async (req, res) => {
    const ch = await storage.getChannel((req.params.id as string));
    if (!ch) return res.status(404).json({ message: "Not found" });
    const orch = await storage.getOrchestrator(ch.orchestratorId);
    if (!orch || !await assertWorkspaceAdmin(req, res, orch.workspaceId)) return;
    const cfg = ch.config as { url?: string } | null;
    if (!cfg?.url) return res.status(400).json({ message: "No URL configured on this channel" });
    try {
      // Format the test payload correctly for each channel type so the
      // receiving service actually accepts and displays it.
      let payload: object;
      if (ch.type === "teams") {
        payload = {
          "@type": "MessageCard",
          "@context": "https://schema.org/extensions",
          themeColor: "6c5ce7",
          summary: "NanoOrch Test Ping",
          sections: [{ activityTitle: "**NanoOrch — Test Ping** ✅", facts: [{ name: "Status", value: "Webhook connection successful" }] }],
        };
      } else if (ch.type === "slack") {
        payload = { text: "✅ *NanoOrch — Test Ping*\nWebhook connection successful" };
      } else if (ch.type === "google_chat") {
        payload = { text: "*✅ NanoOrch — Test Ping*\nWebhook connection successful" };
      } else {
        payload = { event: "test", message: "NanoOrch test ping", timestamp: new Date().toISOString() };
      }
      const body = JSON.stringify(payload);
      const resp = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10000),
      });
      const text = (await resp.text()).slice(0, 500);
      await storage.logChannelDelivery({ channelId: ch.id, event: "test", statusCode: resp.status, responseBody: text });
      res.json({ ok: resp.ok, statusCode: resp.status, response: text });
    } catch (err: any) {
      await storage.logChannelDelivery({ channelId: ch.id, event: "test", error: err.message });
      res.status(502).json({ message: err.message });
    }
  });

  app.get("/api/channels/:id/deliveries", requireAuth, async (req, res) => {
    const ch = await storage.getChannel((req.params.id as string));
    if (!ch) return res.status(404).json({ message: "Not found" });
    const orch = await storage.getOrchestrator(ch.orchestratorId);
    if (!orch || !await assertWorkspaceAdmin(req, res, orch.workspaceId)) return;
    const limit = Math.min(parseInt(req.query.limit as string ?? "50"), 100);
    const deliveries = await storage.listChannelDeliveries((req.params.id as string), limit);
    res.json(deliveries);
  });

  app.post("/api/scheduled-jobs/:id/run", requireAuth, async (req, res) => {
    const job = await storage.getScheduledJob((req.params.id as string));
    if (!job) return res.status(404).json({ message: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, job.workspaceId)) return;
    const orchestrator = await storage.getOrchestrator(job.orchestratorId);
    if (!orchestrator) return res.status(404).json({ message: "Orchestrator not found" });
    const task = await storage.createTask({
      orchestratorId: job.orchestratorId,
      agentId: job.agentId,
      input: job.prompt,
      status: "pending",
      intent: "conversational",
      priority: 5,
    });
    await storage.updateScheduledJob(job.id, { lastRunAt: new Date(), lastTaskId: task.id });
    res.json({ taskId: task.id });
  });

  // ── Approval Requests ─────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/approvals", requireWorkspaceAdmin, async (req, res) => {
    const status = req.query.status as string | undefined;
    const items = await storage.listApprovalRequests(req.params.id as string, status);
    res.json(items);
  });

  app.get("/api/workspaces/:id/approvals/pending-count", requireWorkspaceAdmin, async (req, res) => {
    const count = await storage.countPendingApprovals(req.params.id as string);
    res.json({ count });
  });

  app.post("/api/approvals/:id/resolve", requireAuth, async (req, res) => {
    const { resolution, status } = req.body as { resolution?: string; status: "approved" | "rejected" };
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be approved or rejected" });
    }
    const approval = await storage.getApprovalRequest(req.params.id as string);
    if (!approval) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, approval.workspaceId)) return;
    const user = (req as any).user;
    const updated = await storage.resolveApprovalRequest(
      req.params.id as string,
      user?.username ?? user?.id ?? req.session.userId ?? "unknown",
      resolution ?? "",
      status,
    );
    res.json(updated);
  });

  // ── Pipelines ──────────────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/pipelines", requireWorkspaceAdmin, async (req, res) => {
    const items = await storage.listPipelines(req.params.id as string);
    res.json(items);
  });

  app.post("/api/workspaces/:id/pipelines", requireWorkspaceAdmin, async (req, res) => {
    const { name, description, orchestratorId, cronExpression, timezone, steps } = req.body as {
      name: string;
      description?: string;
      orchestratorId: string;
      cronExpression?: string;
      timezone?: string;
      steps?: Array<{ agentId: string; name: string; promptTemplate: string; stepOrder: number }>;
    };
    const pipeline = await storage.createPipeline({
      workspaceId: req.params.id as string,
      orchestratorId,
      name,
      description: description ?? null,
      isActive: true,
      cronExpression: cronExpression ?? null,
      timezone: timezone ?? "UTC",
    });
    if (steps && steps.length > 0) {
      for (const step of steps) {
        await storage.createPipelineStep({
          pipelineId: pipeline.id,
          agentId: step.agentId,
          name: step.name,
          promptTemplate: step.promptTemplate,
          stepOrder: step.stepOrder,
        });
      }
    }
    res.status(201).json(pipeline);
  });

  app.get("/api/pipelines/:id", requireAuth, async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id as string);
    if (!pipeline) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, pipeline.workspaceId)) return;
    const steps = await storage.listPipelineSteps(pipeline.id);
    res.json({ ...pipeline, steps });
  });

  app.put("/api/pipelines/:id", requireAuth, async (req, res) => {
    const existing = await storage.getPipeline(req.params.id as string);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, existing.workspaceId)) return;
    const { name, description, orchestratorId, cronExpression, timezone, isActive, steps } = req.body as {
      name?: string;
      description?: string;
      orchestratorId?: string;
      cronExpression?: string;
      timezone?: string;
      isActive?: boolean;
      steps?: Array<{ agentId: string; name: string; promptTemplate: string; stepOrder: number }>;
    };
    const updated = await storage.updatePipeline(req.params.id as string, {
      ...(name && { name }),
      ...(description !== undefined && { description }),
      ...(orchestratorId && { orchestratorId }),
      ...(cronExpression !== undefined && { cronExpression }),
      ...(timezone && { timezone }),
      ...(isActive !== undefined && { isActive }),
    });
    if (steps) {
      await storage.deleteAllPipelineSteps(req.params.id as string);
      for (const step of steps) {
        await storage.createPipelineStep({
          pipelineId: req.params.id as string,
          agentId: step.agentId,
          name: step.name,
          promptTemplate: step.promptTemplate,
          stepOrder: step.stepOrder,
        });
      }
    }
    res.json(updated);
  });

  app.delete("/api/pipelines/:id", requireAuth, async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id as string);
    if (!pipeline) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, pipeline.workspaceId)) return;
    await storage.deletePipeline(req.params.id as string);
    res.json({ ok: true });
  });

  app.post("/api/pipelines/:id/run", requireAuth, async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id as string);
    if (!pipeline) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, pipeline.workspaceId)) return;
    const run = await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "pending",
      triggeredBy: "manual",
    });
    executePipeline(run.id).catch(console.error);
    res.status(201).json({ runId: run.id });
  });

  app.get("/api/pipelines/:id/runs", requireAuth, async (req, res) => {
    const pipeline = await storage.getPipeline(req.params.id as string);
    if (!pipeline) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceAdmin(req, res, pipeline.workspaceId)) return;
    const runs = await storage.listPipelineRuns(req.params.id as string);
    res.json(runs);
  });

  app.get("/api/pipeline-runs/:id", requireAuth, async (req, res) => {
    const run = await storage.getPipelineRun(req.params.id as string);
    if (!run) return res.status(404).json({ error: "Not found" });
    const pipeline = await storage.getPipeline(run.pipelineId);
    if (!pipeline || !await assertWorkspaceAdmin(req, res, pipeline.workspaceId)) return;
    const stepRuns = await storage.listPipelineStepRuns(run.id);
    res.json({ ...run, stepRuns });
  });

  // ── Observability ──────────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/observability", requireWorkspaceAdmin, async (req, res) => {
    const days = parseInt(req.query.days as string ?? "30", 10) || 30;
    const stats = await storage.getWorkspaceTokenStats(req.params.id as string, days);
    res.json(stats);
  });

  // ── Seed default admin on startup ─────────────────────────────────────────
  (async () => {
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const configuredPassword = process.env.ADMIN_PASSWORD;

    const existing = await storage.getUserByUsername(adminUsername);
    if (!existing) {
      // Never fall back to a known static password.
      // If ADMIN_PASSWORD is not set, generate a cryptographically random one
      // and print it ONCE so the operator can log in and change it immediately.
      const { randomBytes } = await import("crypto");
      const adminPassword = configuredPassword || randomBytes(16).toString("hex");

      await storage.createUser({
        username: adminUsername,
        passwordHash: hashPassword(adminPassword),
        name: "Administrator",
        role: "admin",
      });

      if (!configuredPassword) {
        console.warn(
          `[auth] ADMIN_PASSWORD not set — generated a random password for '${adminUsername}'.`,
        );
        console.warn(`[auth] One-time password: ${adminPassword}`);
        console.warn("[auth] Log in and change this password immediately.");
      } else {
        console.log(`[auth] Default admin account created: ${adminUsername}`);
      }
    }
  })();

  return httpServer;
}
