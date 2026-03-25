import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { RedisStore } from "connect-redis";
import rateLimit from "express-rate-limit";
import { getRedisClient, makeNodeRedisCompat, RedisRateLimitStore } from "./lib/redis";
import { storage } from "./storage";
import { startQueueWorker } from "./engine/queue";
import { taskLogEmitter } from "./engine/emitter";
import { PROVIDER_MODELS, runAgent } from "./providers";
import { insertWorkspaceSchema, insertOrchestratorSchema, insertAgentSchema, insertChannelSchema, insertTaskSchema } from "@shared/schema";
import { randomUUID, createHash } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp/server";
import { encrypt, decrypt } from "./lib/encryption";
import { validateCredentials, executeCloudTool, retrieveRAGFlowContext } from "./cloud/executor";
import { getToolsForProvider, detectProviderFromToolName, CODE_INTERPRETER_TOOL, SPAWN_AGENT_TOOL } from "./cloud/tools";
import type { ToolDefinition } from "./providers";
import { runCode } from "./engine/sandbox-executor";
import { executeTask } from "./engine/executor";
import { db, pool } from "./db";
import { tasks } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword, requireAuth, requireAdmin, requireWorkspaceAdmin } from "./lib/auth";
import { computeNextRun, validateCron, registerJob, unregisterJob } from "./engine/scheduler";
import { registerHeartbeatJob, unregisterHeartbeatJob, fireHeartbeatNow } from "./engine/heartbeat-scheduler";
import { insertScheduledJobSchema } from "@shared/schema";
import { executePipeline } from "./engine/pipeline-executor";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { loadSecret } from "./lib/secrets";
import { handleSlackEvent, verifySlackSignature } from "./comms/slack-handler";
import { handleTeamsEvent } from "./comms/teams-handler";
import { handleGoogleChatEvent } from "./comms/google-chat-handler";
import { createInferenceProxyRouter } from "./proxy/inference-proxy";

// ── Chat title generator ───────────────────────────────────────────────────────
async function generateChatTitle(firstMessage: string): Promise<string> {
  const prompt = `Generate a concise 3-6 word title for a chat conversation that starts with the following user message. Reply with only the title — no quotes, no punctuation at the end, no explanation.\n\nUser message: ${firstMessage.slice(0, 300)}`;
  try {
    const openaiKey = loadSecret("AI_INTEGRATIONS_OPENAI_API_KEY");
    if (openaiKey) {
      const client = new OpenAI({ apiKey: openaiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
      const res = await client.chat.completions.create({
        model: "gpt-5.4-mini",
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
        model: "claude-haiku-4-5-20251001",
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
// Rate limiters are created lazily inside registerRoutes() once the Redis
// client is available.  The variables below are initialised there.
let loginLimiter:   ReturnType<typeof rateLimit>;
let webhookLimiter: ReturnType<typeof rateLimit>;
let apiLimiter:     ReturnType<typeof rateLimit>;

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

  // Trust reverse-proxy headers (X-Forwarded-For, X-Forwarded-Proto).
  // Must be set before rate limiters so X-Forwarded-For is used as the client IP.
  app.set("trust proxy", 1);

  // ── Redis client (optional — graceful no-op when REDIS_URL is not set) ────
  const redisClient = getRedisClient();
  const makeStore = (windowMs: number, prefix: string) =>
    redisClient ? new RedisRateLimitStore(redisClient, windowMs, prefix) : undefined;

  // ── Rate limiters — Redis store preferred, in-memory fallback ─────────────
  loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(15 * 60 * 1000, "rl:login:"),
    message: { error: "Too many login attempts. Please try again in 15 minutes." },
  });

  webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(60 * 1000, "rl:webhook:"),
    message: { error: "Webhook rate limit exceeded. Maximum 60 requests per minute." },
  });

  apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(60 * 1000, "rl:api:"),
    message: { error: "Too many requests. Please slow down." },
    skip: (req) => req.path.startsWith("/api/tasks/") && req.path.endsWith("/stream"),
  });

  // ── Inference proxy ────────────────────────────────────────────────────────
  // Mounted BEFORE the global API rate-limiter so it only counts against its
  // own budget.  Access is gated by short-lived task tokens, not sessions —
  // only agent containers that are actively running a task can reach it.
  app.use("/internal/proxy", createInferenceProxyRouter());

  app.use(apiLimiter);

  // ── Session store — Redis preferred, PostgreSQL fallback ─────────────────
  const sessionStore = redisClient
    ? new RedisStore({ client: makeNodeRedisCompat(redisClient) as any, prefix: "sess:", ttl: 7 * 24 * 60 * 60 })
    : new (connectPgSimple(session))({
        pool,
        tableName: "user_sessions",
        pruneSessionInterval: 60 * 60, // prune expired sessions hourly
      });

  if (redisClient) {
    console.log("[session] Using Redis store");
  } else {
    console.log("[session] Using PostgreSQL store (set REDIS_URL to enable Redis)");
  }

  app.use(session({
    // loadSecret checks SESSION_SECRET_FILE first (Docker secrets mount),
    // then falls back to SESSION_SECRET env var.
    secret: loadSecret("SESSION_SECRET") || "nanoorch-dev-secret",
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
    store: sessionStore,
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
    if (/^\/api\/channels\/[^/]+\/slack\/interactions$/.test(req.path)) return next();
    if (/^\/api\/channels\/[^/]+\/teams\/events$/.test(req.path)) return next();
    if (/^\/api\/channels\/[^/]+\/google-chat\/event$/.test(req.path)) return next();
    if (/^\/api\/auth\/sso\//.test(req.path)) return next();
    if (/^\/api\/webhooks\//.test(req.path)) return next();
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

  // ── SSO public endpoint — list active providers for login page ────────────
  app.get("/api/sso/providers", async (_req, res) => {
    const providers = await storage.getActiveSsoProviders();
    res.json(providers.map((p) => ({ id: p.id, name: p.name, type: p.type })));
  });

  // ── OIDC — initiate login flow ────────────────────────────────────────────
  app.get("/api/auth/sso/oidc/:id/start", async (req, res) => {
    try {
      const provider = await storage.getSsoProvider(req.params.id);
      if (!provider || !provider.isActive || provider.type !== "oidc") {
        return res.status(404).send("SSO provider not found");
      }
      const cfg = provider.config as { clientId: string; clientSecret: string; discoveryUrl: string };
      const { oidcDiscover, oidcRandomState, oidcRandomCodeVerifier, oidcCodeChallenge, oidcBuildRedirectUrl } = await import("./lib/sso");
      const oidcConfig = await oidcDiscover(cfg);
      const state = oidcRandomState();
      const codeVerifier = oidcRandomCodeVerifier();
      const codeChallenge = await oidcCodeChallenge(codeVerifier);
      const appOrigin = process.env.APP_URL?.replace(/\/$/, "") ||
        (() => { const proto = req.headers["x-forwarded-proto"] ?? req.protocol; const host = req.headers["x-forwarded-host"] ?? req.headers.host; return `${proto}://${host}`; })();
      const redirectUri = `${appOrigin}/api/auth/sso/oidc/${provider.id}/callback`;
      const redirectUrl = oidcBuildRedirectUrl(oidcConfig, redirectUri, state, codeChallenge);
      req.session.oidcState = state;
      req.session.oidcCodeVerifier = codeVerifier;
      req.session.oidcProviderId = provider.id;
      req.session.oidcRedirect = (req.query.redirect as string) || "/workspaces";
      req.session.save(() => res.redirect(redirectUrl));
    } catch (err: any) {
      console.error("[sso/oidc] start error:", err);
      res.redirect(`/login?error=${encodeURIComponent("SSO initiation failed")}`);
    }
  });

  // ── OIDC — callback (code exchange) ──────────────────────────────────────
  app.get("/api/auth/sso/oidc/:id/callback", async (req, res) => {
    try {
      const provider = await storage.getSsoProvider(req.params.id);
      if (!provider || provider.type !== "oidc") return res.status(404).send("SSO provider not found");
      const cfg = provider.config as { clientId: string; clientSecret: string; discoveryUrl: string };
      const { oidcDiscover, oidcHandleCallback } = await import("./lib/sso");
      const oidcConfig = await oidcDiscover(cfg);
      const reqProto = req.headers["x-forwarded-proto"] ?? req.protocol;
      const reqHost = req.headers["x-forwarded-host"] ?? req.headers.host;
      const appOrigin = process.env.APP_URL?.replace(/\/$/, "") || `${reqProto}://${reqHost}`;
      const redirectUri = `${appOrigin}/api/auth/sso/oidc/${provider.id}/callback`;
      const expectedState = req.session.oidcState;
      const codeVerifier = req.session.oidcCodeVerifier;
      const oidcRedirect = req.session.oidcRedirect || "/workspaces";
      if (!expectedState || !codeVerifier) return res.redirect("/login?error=session_expired");
      const currentUrl = new URL(`${reqProto}://${reqHost}${req.originalUrl}`);
      const userInfo = await oidcHandleCallback(oidcConfig, currentUrl, expectedState, codeVerifier, redirectUri);
      if (!userInfo.email) return res.redirect("/login?error=no_email");
      let user = await storage.getUserByEmail(userInfo.email);
      if (!user) {
        const username = userInfo.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_");
        user = await storage.createUser({
          username: `${username}_${Date.now()}`,
          passwordHash: "",
          name: userInfo.name ?? userInfo.email,
          role: (provider.defaultRole as "admin" | "member") ?? "member",
        });
        await storage.upsertUser({ id: user.id, username: user.username ?? undefined, email: userInfo.email, name: user.name ?? undefined, role: user.role ?? "member" } as any);
      }
      req.session.regenerate((err) => {
        if (err) return res.redirect("/login?error=session_error");
        req.session.userId = user!.id;
        req.session.userRole = user!.role ?? "member";
        req.session.csrfToken = randomUUID();
        req.session.save(() => res.redirect(oidcRedirect));
      });
    } catch (err: any) {
      console.error("[sso/oidc] callback error:", err);
      res.redirect(`/login?error=${encodeURIComponent(err.message ?? "SSO failed")}`);
    }
  });

  // ── SAML — initiate login flow ────────────────────────────────────────────
  app.get("/api/auth/sso/saml/:id/start", async (req, res) => {
    try {
      const provider = await storage.getSsoProvider(req.params.id);
      if (!provider || !provider.isActive || provider.type !== "saml") return res.status(404).send("SSO provider not found");
      const cfg = provider.config as { entryPoint: string; cert: string };
      const { samlBuildRedirectUrl } = await import("./lib/sso");
      const samlOrigin = process.env.APP_URL?.replace(/\/$/, "") ||
        (() => { const p = req.headers["x-forwarded-proto"] ?? req.protocol; const h = req.headers["x-forwarded-host"] ?? req.headers.host; return `${p}://${h}`; })();
      const samlCfg = { entryPoint: cfg.entryPoint, cert: cfg.cert, issuer: samlOrigin, callbackUrl: `${samlOrigin}/api/auth/sso/saml/${provider.id}/acs` };
      const url = await samlBuildRedirectUrl(samlCfg);
      req.session.samlProviderId = provider.id;
      req.session.samlRedirect = (req.query.redirect as string) || "/workspaces";
      req.session.save(() => res.redirect(url));
    } catch (err: any) {
      console.error("[sso/saml] start error:", err);
      res.redirect(`/login?error=${encodeURIComponent("SAML initiation failed")}`);
    }
  });

  // ── SAML — ACS (IdP posts the assertion here) ────────────────────────────
  app.post("/api/auth/sso/saml/:id/acs", async (req, res) => {
    try {
      const provider = await storage.getSsoProvider(req.params.id);
      if (!provider || provider.type !== "saml") return res.status(404).send("SSO provider not found");
      const cfg = provider.config as { entryPoint: string; cert: string };
      const { samlValidateResponse } = await import("./lib/sso");
      const acsOrigin = process.env.APP_URL?.replace(/\/$/, "") ||
        (() => { const p = req.headers["x-forwarded-proto"] ?? req.protocol; const h = req.headers["x-forwarded-host"] ?? req.headers.host; return `${p}://${h}`; })();
      const samlCfg = { entryPoint: cfg.entryPoint, cert: cfg.cert, issuer: acsOrigin, callbackUrl: `${acsOrigin}/api/auth/sso/saml/${provider.id}/acs` };
      const userInfo = await samlValidateResponse(samlCfg, req.body);
      if (!userInfo.email) return res.redirect("/login?error=no_email");
      const samlRedirect = req.session.samlRedirect || "/workspaces";
      let user = await storage.getUserByEmail(userInfo.email);
      if (!user) {
        const username = userInfo.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_");
        user = await storage.createUser({
          username: `${username}_${Date.now()}`,
          passwordHash: "",
          name: userInfo.name ?? userInfo.email,
          role: (provider.defaultRole as "admin" | "member") ?? "member",
        });
        await storage.upsertUser({ id: user.id, username: user.username ?? undefined, email: userInfo.email, name: user.name ?? undefined, role: user.role ?? "member" } as any);
      }
      req.session.regenerate((err) => {
        if (err) return res.redirect("/login?error=session_error");
        req.session.userId = user!.id;
        req.session.userRole = user!.role ?? "member";
        req.session.csrfToken = randomUUID();
        req.session.save(() => res.redirect(samlRedirect));
      });
    } catch (err: any) {
      console.error("[sso/saml] acs error:", err);
      res.redirect(`/login?error=${encodeURIComponent(err.message ?? "SAML failed")}`);
    }
  });

  // ── SAML — SP metadata (for configuring the IdP) ─────────────────────────
  app.get("/api/auth/sso/saml/:id/metadata", async (req, res) => {
    try {
      const provider = await storage.getSsoProvider(req.params.id);
      if (!provider || provider.type !== "saml") return res.status(404).send("Not found");
      const cfg = provider.config as { entryPoint: string; cert: string };
      const { samlGetMetadata } = await import("./lib/sso");
      const metaOrigin = process.env.APP_URL?.replace(/\/$/, "") ||
        (() => { const p = req.headers["x-forwarded-proto"] ?? req.protocol; const h = req.headers["x-forwarded-host"] ?? req.headers.host; return `${p}://${h}`; })();
      const samlCfg = { entryPoint: cfg.entryPoint, cert: cfg.cert, issuer: metaOrigin, callbackUrl: `${metaOrigin}/api/auth/sso/saml/${provider.id}/acs` };
      const xml = samlGetMetadata(samlCfg);
      res.type("application/xml").send(xml);
    } catch (err) {
      res.status(500).send("Metadata generation failed");
    }
  });

  // ── Admin — SSO Provider CRUD ─────────────────────────────────────────────
  app.get("/api/admin/sso-providers", requireAdmin, async (_req, res) => {
    const providers = await storage.listSsoProviders();
    res.json(providers);
  });

  app.post("/api/admin/sso-providers", requireAdmin, async (req, res) => {
    const { name, type, isActive, config, defaultRole } = req.body;
    if (!name || !type || !config) return res.status(400).json({ error: "name, type and config are required" });
    const provider = await storage.createSsoProvider({ name, type, isActive: isActive ?? true, config, defaultRole: defaultRole ?? "member" });
    res.status(201).json(provider);
  });

  app.put("/api/admin/sso-providers/:id", requireAdmin, async (req, res) => {
    const { name, type, isActive, config, defaultRole } = req.body;
    const provider = await storage.updateSsoProvider(req.params.id as string, { name, type, isActive, config, defaultRole });
    res.json(provider);
  });

  app.delete("/api/admin/sso-providers/:id", requireAdmin, async (req, res) => {
    await storage.deleteSsoProvider(req.params.id as string);
    res.json({ ok: true });
  });

  // ── Global auth guard (after public routes above) ─────────────────────────
  app.use("/api", (req, res, next) => {
    const isPublic =
      req.path.startsWith("/auth/") ||
      req.path.startsWith("/sso/") ||
      req.path.startsWith("/webhooks/") ||
      /^\/channels\/[^/]+\/webhook$/.test(req.path) ||
      /^\/channels\/[^/]+\/slack\/events$/.test(req.path) ||
      /^\/channels\/[^/]+\/slack\/interactions$/.test(req.path) ||
      /^\/channels\/[^/]+\/teams\/events$/.test(req.path) ||
      /^\/channels\/[^/]+\/google-chat\/event$/.test(req.path);
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
            allowedAiProviders, allowedCloudProviders, allowedChannelTypes,
            utilizationAlertThresholdTokens, utilizationAlertChannelId } = req.body;
    const cfg = await storage.upsertWorkspaceConfig(req.params.id as string, {
      maxOrchestrators: maxOrchestrators ?? null,
      maxAgents: maxAgents ?? null,
      maxChannels: maxChannels ?? null,
      maxScheduledJobs: maxScheduledJobs ?? null,
      allowedAiProviders: allowedAiProviders ?? null,
      allowedCloudProviders: allowedCloudProviders ?? null,
      allowedChannelTypes: allowedChannelTypes ?? null,
      utilizationAlertThresholdTokens: utilizationAlertThresholdTokens ?? null,
      utilizationAlertChannelId: utilizationAlertChannelId ?? null,
    });
    res.json(cfg);
  });

  app.get("/api/workspaces/:id/channels", requireAuth, async (req, res) => {
    const channels = await storage.listChannelsForWorkspace(req.params.id as string);
    res.json(channels);
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
    if (agent.heartbeatEnabled) registerHeartbeatJob(agent);
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
    if (agent.heartbeatEnabled) {
      registerHeartbeatJob(agent);
    } else {
      unregisterHeartbeatJob(agent.id);
    }
    res.json(agent);
  });

  app.delete("/api/agents/:id", requireAuth, async (req, res) => {
    unregisterHeartbeatJob(req.params.id as string);
    await storage.deleteAgent(req.params.id as string);
    res.status(204).send();
  });

  app.post("/api/agents/:id/heartbeat/fire", requireAuth, async (req, res) => {
    try {
      const taskId = await fireHeartbeatNow(req.params.id as string);
      res.json({ taskId, message: "Heartbeat fired" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
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

  app.post("/api/channels/:id/slack/interactions", webhookLimiter, async (req, res) => {
    const channelId = req.params.id as string;

    const channel = await storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ error: "channel not found" });
    const cfg = channel.config as any;

    if (cfg?.signingSecret) {
      if (!verifySlackSignature(cfg.signingSecret as string, req)) {
        return res.status(401).json({ error: "invalid signature" });
      }
    }

    let payload: any;
    try {
      const rawPayload = typeof req.body?.payload === "string" ? req.body.payload : JSON.stringify(req.body);
      payload = JSON.parse(typeof req.body?.payload === "string" ? req.body.payload : rawPayload);
    } catch {
      return res.status(400).json({ error: "invalid payload" });
    }
    res.status(200).send("");
    setImmediate(async () => {
      try {
        if (!channel) return;
        const action = payload?.actions?.[0];
        if (!action) return;
        const approvalId = action.value as string;
        const actionId = action.action_id as string;
        const status = actionId === "approval_approve" ? "approved" : "rejected";
        const approval = await storage.getApprovalRequest(approvalId);
        if (!approval || approval.status !== "pending") return;
        const userName = payload?.user?.name ?? payload?.user?.id ?? "slack-user";
        await storage.resolveApprovalRequest(approvalId, userName, "", status);
        const replyText = status === "approved"
          ? `✅ Approval granted for: ${approval.action}`
          : `❌ Approval rejected for: ${approval.action}`;
        const replyTs = payload?.message?.thread_ts ?? payload?.container?.message_ts ?? payload?.message?.ts;
        if (cfg?.botToken && payload?.container?.channel_id && replyTs) {
          const botToken = cfg.botToken as string;
          const chan = payload.container.channel_id as string;
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ channel: chan, thread_ts: replyTs, text: replyText }),
            signal: AbortSignal.timeout(10_000),
          });
        }
        if (status === "approved" && approval.taskId) {
          const originalTask = await storage.getTask(approval.taskId);
          if (originalTask) {
            const newTask = await storage.createTask({
              orchestratorId: originalTask.orchestratorId,
              agentId: originalTask.agentId ?? undefined,
              channelId: originalTask.channelId ?? undefined,
              commsThreadId: originalTask.commsThreadId ?? undefined,
              intent: (originalTask.intent as "action" | "code_execution" | "conversational") ?? undefined,
              input: `${originalTask.input}\n\n[System: Approval has been granted for action "${approval.action}". Please proceed with the approved action.]`,
              status: "pending",
              priority: originalTask.priority ?? 5,
              bypassApproval: true,
            });
            setImmediate(() => executeTask(newTask.id).catch(console.error));
          }
        }
      } catch (err) {
        console.error("[slack/interactions] error:", err);
      }
    });
  });

  app.post("/api/channels/:id/teams/events", webhookLimiter, async (req, res) => {
    await handleTeamsEvent(req.params.id as string, req, res);
  });

  app.post("/api/channels/:id/google-chat/event", webhookLimiter, async (req, res) => {
    await handleGoogleChatEvent(req.params.id as string, req, res);
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
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const status = req.query.status as string | undefined;
    const offset = (page - 1) * limit;
    const [taskList, total, pendingCount, runningCount, completedCount, failedCount] = await Promise.all([
      storage.listTasks(req.params.id as string, limit, offset, status),
      storage.countTasks(req.params.id as string, status),
      storage.countTasks(req.params.id as string, "pending"),
      storage.countTasks(req.params.id as string, "running"),
      storage.countTasks(req.params.id as string, "completed"),
      storage.countTasks(req.params.id as string, "failed"),
    ]);
    res.json({
      tasks: taskList, total, page, limit,
      totalPages: Math.ceil(total / limit),
      stats: { pending: pendingCount, running: runningCount, completed: completedCount, failed: failedCount },
    });
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
        let existingRaw: Record<string, string> = {};
        try {
          existingRaw = JSON.parse(decrypt(existing.credentialsEncrypted));
        } catch {
          // Credentials were encrypted with a different key (e.g. SESSION_SECRET changed).
          // If the caller is providing new values we do a full replacement; otherwise reject
          // with a clear message so the user knows to re-enter all credential fields.
          const hasNewValues = Object.values(incoming).some(
            (v) => typeof v === "string" && (v as string).trim(),
          );
          if (!hasNewValues) {
            return res.status(422).json({
              error:
                "Cannot decrypt existing credentials — the encryption key has changed. " +
                "Please re-enter all credential fields to update this integration.",
            });
          }
          // existingRaw stays empty; incoming values will populate all fields below
        }
        const merged = { ...existingRaw };
        const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
        for (const [k, v] of Object.entries(incoming)) {
          if (UNSAFE_KEYS.has(k)) continue;
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

      // IMPORTANT: every provider MUST have its own explicit else-if branch here.
      // NEVER use a catch-all else to handle a specific provider — it causes silent
      // credential mismatches when new providers are added (e.g. slack getting treated as azure).
      // Add a new else-if for each new provider; keep the final else as an unknown-provider guard.
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
      } else if (ci.provider === "slack") {
        creds = { provider: "slack", credentials: { botToken: raw.botToken, defaultChannel: raw.defaultChannel } };
      } else if (ci.provider === "google_chat") {
        creds = { provider: "google_chat", credentials: { webhookUrl: raw.webhookUrl } };
      } else if (ci.provider === "azure") {
        creds = { provider: "azure", credentials: { clientId: raw.clientId, clientSecret: raw.clientSecret, tenantId: raw.tenantId, subscriptionId: raw.subscriptionId } };
      } else {
        return res.json({ ok: false, detail: `Unknown provider: ${ci.provider}` });
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

  app.get("/api/workspaces/:id/activity", requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 50);
    const items = await storage.getWorkspaceActivity(req.params.id as string, limit);
    res.json(items);
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
    const orchForClassify = await storage.getOrchestrator(parsed.data.orchestratorId);
    const VALID_INTENTS = ["action", "code_execution", "conversational"];
    const intentOverride = parsed.data.intent && VALID_INTENTS.includes(parsed.data.intent) ? parsed.data.intent : null;
    const classifiedIntent = intentOverride ?? (orchForClassify
      ? await classifyIntent(parsed.data.prompt, orchForClassify.provider, orchForClassify.model, orchForClassify.baseUrl)
      : "conversational");
    const nextRunAt = computeNextRun(cronExpression, timezone ?? "UTC");
    const job = await storage.createScheduledJob({ ...parsed.data, intent: classifiedIntent, ...(nextRunAt ? { nextRunAt } : {}) });
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
    const VALID_INTENTS_PUT = ["action", "code_execution", "conversational"];
    let intentUpdate: { intent?: string } = {};
    if (rest.intent && VALID_INTENTS_PUT.includes(rest.intent)) {
      intentUpdate.intent = rest.intent;
    } else if (rest.prompt) {
      const effectiveOrchId = rest.orchestratorId ?? existing.orchestratorId;
      const orchForReclassify = await storage.getOrchestrator(effectiveOrchId);
      if (orchForReclassify) {
        intentUpdate.intent = await classifyIntent(rest.prompt, orchForReclassify.provider, orchForReclassify.model, orchForReclassify.baseUrl);
      }
    }
    const job = await storage.updateScheduledJob((req.params.id as string), {
      ...rest,
      ...intentUpdate,
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
      intent: (job.intent as "action" | "code_execution" | "conversational") ?? "conversational",
      bypassApproval: job.bypassApproval ?? false,
      priority: 5,
    });
    await storage.updateScheduledJob(job.id, { lastRunAt: new Date(), lastTaskId: task.id });
    res.json({ taskId: task.id });
  });

  // ── Approval Requests ─────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/approvals", requireWorkspaceAdmin, async (req, res) => {
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const offset = (page - 1) * limit;
    const [items, total] = await Promise.all([
      storage.listApprovalRequests(req.params.id as string, status, limit, offset),
      storage.countApprovalRequests(req.params.id as string, status),
    ]);
    res.json({ approvals: items, total, page, limit, totalPages: Math.ceil(total / limit) });
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

  // ── Event Triggers CRUD (workspace-scoped, admin) ─────────────────────────
  app.get("/api/workspaces/:wid/triggers", requireAuth, requireWorkspaceAdmin, async (req, res) => {
    const triggers = await storage.listEventTriggers(req.params.wid as string);
    res.json(triggers);
  });

  app.post("/api/workspaces/:wid/triggers", requireAuth, requireWorkspaceAdmin, async (req, res) => {
    const { orchestratorId, agentId, name, source, eventTypes, promptTemplate, secretToken, filterConfig, isActive, bypassApproval } = req.body;
    if (!orchestratorId || !agentId || !name || !source || !promptTemplate) {
      return res.status(400).json({ error: "orchestratorId, agentId, name, source and promptTemplate are required" });
    }
    const trigger = await storage.createEventTrigger({
      workspaceId: req.params.wid as string,
      orchestratorId,
      agentId,
      name,
      source,
      eventTypes: eventTypes ?? [],
      promptTemplate,
      secretToken: secretToken ?? null,
      filterConfig: filterConfig ?? {},
      isActive: isActive ?? true,
      bypassApproval: bypassApproval ?? false,
    });
    res.status(201).json(trigger);
  });

  app.put("/api/workspaces/:wid/triggers/:tid", requireAuth, requireWorkspaceAdmin, async (req, res) => {
    const trigger = await storage.getEventTrigger(req.params.tid as string);
    if (!trigger || trigger.workspaceId !== (req.params.wid as string)) return res.status(404).json({ error: "Not found" });
    const updated = await storage.updateEventTrigger(req.params.tid as string, req.body);
    res.json(updated);
  });

  app.delete("/api/workspaces/:wid/triggers/:tid", requireAuth, requireWorkspaceAdmin, async (req, res) => {
    const trigger = await storage.getEventTrigger(req.params.tid as string);
    if (!trigger || trigger.workspaceId !== (req.params.wid as string)) return res.status(404).json({ error: "Not found" });
    await storage.deleteEventTrigger(req.params.tid as string);
    res.json({ ok: true });
  });

  app.get("/api/workspaces/:wid/triggers/:tid/events", requireAuth, requireWorkspaceAdmin, async (req, res) => {
    const trigger = await storage.getEventTrigger(req.params.tid as string);
    if (!trigger || trigger.workspaceId !== (req.params.wid as string)) return res.status(404).json({ error: "Not found" });
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const offset = (page - 1) * limit;
    const [events, total] = await Promise.all([
      storage.listTriggerEvents(req.params.tid as string, limit, offset),
      storage.countTriggerEvents(req.params.tid as string),
    ]);
    res.json({ events, total, page, limit, totalPages: Math.ceil(total / limit) });
  });

  // ── Webhook trigger helpers ───────────────────────────────────────────────
  async function fireTrigger(trigger: { id: string; orchestratorId: string; agentId: string; source: string; eventTypes: string[] | null; promptTemplate: string; bypassApproval?: boolean | null }, eventType: string, payload: Record<string, unknown>) {
    const types = trigger.eventTypes ?? [];
    const matched = types.length === 0 || types.some((t) => eventType.toLowerCase().includes(t.toLowerCase()) || t === "*");

    const renderTemplate = (template: string, data: Record<string, unknown>): string => {
      return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
        const keys = path.trim().split(".");
        let val: unknown = data;
        for (const k of keys) { val = (val as Record<string, unknown>)?.[k]; }
        return val != null ? String(val) : "";
      });
    };

    if (!matched) {
      await storage.logTriggerEvent({ triggerId: trigger.id, source: trigger.source, eventType, payloadPreview: JSON.stringify(payload).slice(0, 400), matched: false });
      return;
    }

    const prompt = renderTemplate(trigger.promptTemplate, { payload });
    const orchestrator = await storage.getOrchestrator(trigger.orchestratorId);
    if (!orchestrator) {
      await storage.logTriggerEvent({ triggerId: trigger.id, source: trigger.source, eventType, payloadPreview: JSON.stringify(payload).slice(0, 400), matched: true, error: "Orchestrator not found" });
      return;
    }
    const intent = await classifyIntent(prompt, orchestrator.provider, orchestrator.model, orchestrator.baseUrl);
    const task = await storage.createTask({
      orchestratorId: trigger.orchestratorId,
      agentId: trigger.agentId,
      input: prompt,
      status: "pending",
      intent,
      bypassApproval: trigger.bypassApproval ?? false,
      priority: 5,
    });
    await executeTask(task.id);
    await storage.logTriggerEvent({ triggerId: trigger.id, source: trigger.source, eventType, payloadPreview: JSON.stringify(payload).slice(0, 400), matched: true, taskId: task.id });
  }

  // ── GitHub Webhook ────────────────────────────────────────────────────────
  app.post("/api/webhooks/github/:triggerId", webhookLimiter, async (req, res) => {
    const trigger = await storage.getEventTrigger(req.params.triggerId as string);
    if (!trigger || !trigger.isActive || trigger.source !== "github") return res.status(404).json({ error: "Trigger not found" });

    if (trigger.secretToken) {
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      if (!sig) return res.status(401).json({ error: "Missing signature" });
      const { createHmac } = await import("crypto");
      const expected = "sha256=" + createHmac("sha256", trigger.secretToken).update(JSON.stringify(req.body)).digest("hex");
      if (sig !== expected) return res.status(401).json({ error: "Invalid signature" });
    }

    const eventType = (req.headers["x-github-event"] as string) ?? "push";
    res.json({ ok: true });
    fireTrigger(trigger, eventType, req.body).catch(console.error);
  });

  // ── GitLab Webhook ────────────────────────────────────────────────────────
  app.post("/api/webhooks/gitlab/:triggerId", webhookLimiter, async (req, res) => {
    const trigger = await storage.getEventTrigger(req.params.triggerId as string);
    if (!trigger || !trigger.isActive || trigger.source !== "gitlab") return res.status(404).json({ error: "Trigger not found" });

    if (trigger.secretToken) {
      const token = req.headers["x-gitlab-token"] as string | undefined;
      if (token !== trigger.secretToken) return res.status(401).json({ error: "Invalid token" });
    }

    const rawEvent = (req.headers["x-gitlab-event"] as string) ?? "";
    const eventType = rawEvent.toLowerCase().replace(/\s+hook$/, "").replace(/\s+/g, "_");
    res.json({ ok: true });
    fireTrigger(trigger, eventType, req.body).catch(console.error);
  });

  // ── Jira Webhook ──────────────────────────────────────────────────────────
  app.post("/api/webhooks/jira/:triggerId", webhookLimiter, async (req, res) => {
    const trigger = await storage.getEventTrigger(req.params.triggerId as string);
    if (!trigger || !trigger.isActive || trigger.source !== "jira") return res.status(404).json({ error: "Trigger not found" });

    if (trigger.secretToken) {
      const token = (req.query.token as string) ?? req.headers["x-jira-token"];
      if (token !== trigger.secretToken) return res.status(401).json({ error: "Invalid token" });
    }

    const eventType: string = (req.body?.webhookEvent as string) ?? (req.body?.issue_event_type_name as string) ?? "jira:issue_updated";
    res.json({ ok: true });
    fireTrigger(trigger, eventType, req.body).catch(console.error);
  });

  // ── Seed default admin on startup ─────────────────────────────────────────
  (async () => {
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    // loadSecret checks ADMIN_PASSWORD_FILE first (Docker secrets), then
    // falls back to the plain ADMIN_PASSWORD environment variable.
    const configuredPassword = loadSecret("ADMIN_PASSWORD");

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
        console.warn(`[auth] One-time password: ${adminPassword.slice(0, 4)}${"*".repeat(adminPassword.length - 4)} (set ADMIN_PASSWORD env var to choose your own)`);
        console.warn("[auth] Log in and change this password immediately.");
      } else {
        console.log(`[auth] Default admin account created: ${adminUsername}`);
      }
    }
  })();

  // ── MCP API Keys ─────────────────────────────────────────────────────────────
  app.get("/api/workspaces/:id/mcp-keys", requireWorkspaceAdmin, async (req, res) => {
    const keys = await storage.listMcpApiKeys(req.params.id as string);
    res.json(keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })));
  });

  app.post("/api/workspaces/:id/mcp-keys", requireWorkspaceAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
    const raw = `nano_mcp_${randomUUID().replace(/-/g, "")}`;
    const keyHash = createHash("sha256").update(raw).digest("hex");
    const key = await storage.createMcpApiKey({
      workspaceId: req.params.id as string,
      name: name.trim(),
      keyHash,
      createdBy: (req as any).user?.id,
    });
    res.status(201).json({ id: key.id, name: key.name, createdAt: key.createdAt, key: raw });
  });

  app.delete("/api/mcp-keys/:id", requireAuth, async (req, res) => {
    await storage.deleteMcpApiKey(req.params.id as string);
    res.json({ success: true });
  });

  // ── MCP HTTP/SSE Endpoint ─────────────────────────────────────────────────────
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

  async function mcpAuthMiddleware(req: Request, res: Response, next: () => void) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }
    const raw = auth.slice(7);
    const keyHash = createHash("sha256").update(raw).digest("hex");
    const apiKey = await storage.getMcpApiKeyByHash(keyHash);
    if (!apiKey) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    storage.updateMcpApiKeyLastUsed(apiKey.id).catch(() => {});
    (req as any).mcpWorkspaceId = apiKey.workspaceId;
    next();
  }

  app.all("/mcp", mcpAuthMiddleware as any, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && mcpSessions.has(sessionId)) {
        const transport = mcpSessions.get(sessionId)!;
        await transport.handleRequest(req as any, res as any, req.body);
        return;
      }

      if (sessionId && !mcpSessions.has(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const workspaceId = (req as any).mcpWorkspaceId as string;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { mcpSessions.set(id, transport); },
        onsessionclosed: (id) => { mcpSessions.delete(id); },
      });

      const mcpServer = createMcpServer(workspaceId);
      await mcpServer.connect(transport);
      await transport.handleRequest(req as any, res as any, req.body);
    } catch (err: any) {
      console.error("[mcp] Error handling request:", err);
      if (!res.headersSent) res.status(500).json({ error: "MCP error" });
    }
  });

  return httpServer;
}
