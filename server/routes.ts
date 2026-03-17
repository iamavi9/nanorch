import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import session from "express-session";
import MemoryStore from "memorystore";
import { storage } from "./storage";
import { startQueueWorker } from "./engine/queue";
import { taskLogEmitter } from "./engine/emitter";
import { PROVIDER_MODELS, runAgent } from "./providers";
import { insertWorkspaceSchema, insertOrchestratorSchema, insertAgentSchema, insertChannelSchema, insertTaskSchema } from "@shared/schema";
import { randomUUID } from "crypto";
import { encrypt, decrypt } from "./lib/encryption";
import { validateCredentials, executeCloudTool, retrieveRAGFlowContext } from "./cloud/executor";
import { getToolsForProvider, detectProviderFromToolName, CODE_INTERPRETER_TOOL } from "./cloud/tools";
import type { ToolDefinition } from "./providers";
import { runCode } from "./engine/sandbox-executor";
import { executeTask } from "./engine/executor";
import { db } from "./db";
import { tasks } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword, requireAuth, requireAdmin } from "./lib/auth";

async function classifyIntent(content: string, provider: string, model: string, baseUrl?: string | null): Promise<"action" | "code_execution" | "conversational"> {
  try {
    const result = await runAgent({
      provider: provider as any,
      model,
      baseUrl,
      systemPrompt:
        "You are an intent classifier. Reply with ONLY one word: 'action', 'code_execution', or 'conversational'.\n" +
        "'action' = the message wants to perform a cloud operation: list/create/delete/describe/run/manage/deploy/check/fetch real resources on AWS, GCP, Azure, or RAGFlow.\n" +
        "'code_execution' = the message asks to write code, run code, execute a script, show a code example with output, compute something programmatically, analyse data, demonstrate a programming concept with working code, or produce any output that requires running code (e.g. Hello World, fibonacci, hash, date calculations, sorting, etc.).\n" +
        "'conversational' = general questions, explanations of concepts without needing to run code, greetings, discussion, or anything else.",
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

const MemStore = MemoryStore(session);

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await db.update(tasks)
    .set({ status: "failed", errorMessage: "Interrupted by server restart", completedAt: new Date() })
    .where(eq(tasks.status, "running"));

  startQueueWorker();

  app.use(session({
    secret: process.env.SESSION_SECRET || "nanoorch-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
    store: new MemStore({ checkPeriod: 86400000 }),
  }));

  // ── Auth routes (public) ──────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const user = await storage.getUserByUsername(username);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    req.session.userId = user.id;
    req.session.userRole = user.role ?? "member";
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {});
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.session?.userId) return res.json(null);
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.json(null);
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
  });

  app.get("/api/auth/my-workspaces", requireAuth, async (req, res) => {
    const workspaces = await storage.getUserWorkspaces(req.session.userId!);
    res.json(workspaces);
  });

  // ── Global auth guard (after public routes above) ─────────────────────────
  app.use("/api", (req, res, next) => {
    const isPublic =
      req.path.startsWith("/auth/") ||
      /^\/channels\/[^/]+\/webhook$/.test(req.path);
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

  app.get("/api/workspaces", async (_req, res) => {
    const ws = await storage.listWorkspaces();
    res.json(ws);
  });

  app.post("/api/workspaces", async (req, res) => {
    const parsed = insertWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const ws = await storage.createWorkspace(parsed.data);
    res.status(201).json(ws);
  });

  app.get("/api/workspaces/:id", async (req, res) => {
    const ws = await storage.getWorkspace(req.params.id);
    if (!ws) return res.status(404).json({ error: "Not found" });
    res.json(ws);
  });

  app.put("/api/workspaces/:id", async (req, res) => {
    const ws = await storage.updateWorkspace(req.params.id, req.body);
    res.json(ws);
  });

  app.delete("/api/workspaces/:id", async (req, res) => {
    await storage.deleteWorkspace(req.params.id);
    res.status(204).send();
  });

  app.get("/api/workspaces/:id/orchestrators", async (req, res) => {
    const orchs = await storage.listOrchestrators(req.params.id);
    res.json(orchs);
  });

  app.post("/api/workspaces/:id/orchestrators", async (req, res) => {
    const parsed = insertOrchestratorSchema.safeParse({ ...req.body, workspaceId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const orch = await storage.createOrchestrator(parsed.data);
    res.status(201).json(orch);
  });

  app.get("/api/orchestrators/:id", async (req, res) => {
    const orch = await storage.getOrchestrator(req.params.id);
    if (!orch) return res.status(404).json({ error: "Not found" });
    res.json(orch);
  });

  app.put("/api/orchestrators/:id", async (req, res) => {
    const orch = await storage.updateOrchestrator(req.params.id, req.body);
    res.json(orch);
  });

  app.delete("/api/orchestrators/:id", async (req, res) => {
    await storage.deleteOrchestrator(req.params.id);
    res.status(204).send();
  });

  app.get("/api/orchestrators/:id/agents", async (req, res) => {
    const agentList = await storage.listAgents(req.params.id);
    res.json(agentList);
  });

  app.post("/api/orchestrators/:id/agents", async (req, res) => {
    const parsed = insertAgentSchema.safeParse({ ...req.body, orchestratorId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const agent = await storage.createAgent(parsed.data);
    res.status(201).json(agent);
  });

  app.get("/api/agents/:id", async (req, res) => {
    const agent = await storage.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Not found" });
    res.json(agent);
  });

  app.put("/api/agents/:id", async (req, res) => {
    const parsed = insertAgentSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const agent = await storage.updateAgent(req.params.id, parsed.data);
    res.json(agent);
  });

  app.delete("/api/agents/:id", async (req, res) => {
    await storage.deleteAgent(req.params.id);
    res.status(204).send();
  });

  app.get("/api/orchestrators/:id/channels", async (req, res) => {
    const chList = await storage.listChannels(req.params.id);
    res.json(chList);
  });

  app.post("/api/orchestrators/:id/channels", async (req, res) => {
    const parsed = insertChannelSchema.safeParse({ ...req.body, orchestratorId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const ch = await storage.createChannel(parsed.data);
    res.status(201).json(ch);
  });

  app.get("/api/channels/:id", async (req, res) => {
    const ch = await storage.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: "Not found" });
    res.json(ch);
  });

  app.put("/api/channels/:id", async (req, res) => {
    const ch = await storage.updateChannel(req.params.id, req.body);
    res.json(ch);
  });

  app.delete("/api/channels/:id", async (req, res) => {
    await storage.deleteChannel(req.params.id);
    res.status(204).send();
  });

  app.post("/api/channels/:id/webhook", async (req, res) => {
    const ch = await storage.getChannel(req.params.id);
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

  app.get("/api/orchestrators/:id/tasks", async (req, res) => {
    const taskList = await storage.listTasks(req.params.id, 100);
    res.json(taskList);
  });

  app.post("/api/orchestrators/:id/tasks", async (req, res) => {
    const orch = await storage.getOrchestrator(req.params.id);
    if (!orch) return res.status(404).json({ error: "Orchestrator not found" });
    const { input, agentId } = req.body;
    if (!input) return res.status(400).json({ error: "input is required" });

    const task = await storage.createTask({
      orchestratorId: req.params.id,
      agentId: agentId ?? null,
      channelId: null,
      input,
      status: "pending",
      priority: req.body.priority ?? 5,
    });
    res.status(201).json(task);
  });

  app.get("/api/tasks/:id", async (req, res) => {
    const task = await storage.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Not found" });
    res.json(task);
  });

  app.get("/api/tasks/:id/logs", async (req, res) => {
    const logs = await storage.listTaskLogs(req.params.id);
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

  app.get("/api/stats", async (_req, res) => {
    const allTasks = await storage.listAllTasks(1000);
    const completed = allTasks.filter((t) => t.status === "completed").length;
    const failed = allTasks.filter((t) => t.status === "failed").length;
    const running = allTasks.filter((t) => t.status === "running").length;
    const pending = allTasks.filter((t) => t.status === "pending").length;
    res.json({ total: allTasks.length, completed, failed, running, pending });
  });

  app.get("/api/workspaces/:id/integrations", async (req, res) => {
    const list = await storage.listCloudIntegrations(req.params.id);
    const safe = list.map(({ credentialsEncrypted: _, ...rest }) => rest);
    res.json(safe);
  });

  app.post("/api/workspaces/:id/integrations", async (req, res) => {
    const { name, provider, credentials, scopes, integrationMode } = req.body;
    if (!name || !provider || !credentials) {
      return res.status(400).json({ error: "name, provider, and credentials are required" });
    }
    const credStr = typeof credentials === "string" ? credentials : JSON.stringify(credentials);
    const credentialsEncrypted = encrypt(credStr);
    const ci = await storage.createCloudIntegration({
      workspaceId: req.params.id,
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

  app.get("/api/integrations/:id", async (req, res) => {
    const ci = await storage.getCloudIntegration(req.params.id);
    if (!ci) return res.status(404).json({ error: "Not found" });
    const { credentialsEncrypted: _, ...safe } = ci;
    res.json(safe);
  });

  app.put("/api/integrations/:id", async (req, res) => {
    const { credentials, ...rest } = req.body;
    const updateData: Record<string, unknown> = { ...rest };
    if (credentials) {
      const credStr = typeof credentials === "string" ? credentials : JSON.stringify(credentials);
      updateData.credentialsEncrypted = encrypt(credStr);
    }
    const ci = await storage.updateCloudIntegration(req.params.id, updateData as any);
    const { credentialsEncrypted: _, ...safe } = ci;
    res.json(safe);
  });

  app.delete("/api/integrations/:id", async (req, res) => {
    await storage.deleteCloudIntegration(req.params.id);
    res.status(204).send();
  });

  app.post("/api/integrations/:id/test", async (req, res) => {
    const ci = await storage.getCloudIntegration(req.params.id);
    if (!ci) return res.status(404).json({ error: "Not found" });

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

  app.get("/api/workspaces/:id/agents", async (req, res) => {
    const agents = await storage.listAgentsForWorkspace(req.params.id);
    res.json(agents);
  });

  app.get("/api/workspaces/:id/stats", async (req, res) => {
    const stats = await storage.getWorkspaceStats(req.params.id);
    res.json(stats);
  });

  app.get("/api/workspaces/:id/conversations", async (req, res) => {
    const convs = await storage.listChatConversations(req.params.id);
    res.json(convs);
  });

  app.post("/api/workspaces/:id/conversations", async (req, res) => {
    const { title } = req.body;
    const conv = await storage.createChatConversation({ workspaceId: req.params.id, title: title ?? "New Chat" });
    res.status(201).json(conv);
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    await storage.deleteChatConversation(req.params.id);
    res.status(204).send();
  });

  app.get("/api/conversations/:id/messages", async (req, res) => {
    const messages = await storage.listChatMessages(req.params.id);
    res.json(messages);
  });

  app.get("/api/workspaces/:id/default-conversation", async (req, res) => {
    const conv = await storage.getOrCreateDefaultConversation(req.params.id);
    res.json(conv);
  });

  app.post("/api/conversations/:id/chat", async (req, res) => {
    const { content, mentionedAgentIds } = req.body as { content: string; mentionedAgentIds: string[] };
    if (!content?.trim()) return res.status(400).json({ error: "content required" });

    const conv = await storage.getChatConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const userMsg = await storage.createChatMessage({
      conversationId: req.params.id,
      role: "user",
      content: content.trim(),
      mentions: mentionedAgentIds ?? [],
    });

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

    const history = await storage.listChatMessages(req.params.id);
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

        if (intent === "action" && hasCloud) {
          const confirmMsg = await storage.createChatMessage({
            conversationId: req.params.id,
            role: "system",
            agentId,
            agentName: agentMeta.name,
            content: `**${agentMeta.name}** wants to perform a cloud action in an isolated environment.`,
            messageType: "pending_confirmation",
            metadata: {
              agentId,
              agentName: agentMeta.name,
              proposedAction: content.trim(),
              status: "pending",
            },
          });
          send({ type: "confirmation", message: confirmMsg });
        } else {
          send({ type: "agent_start", agentId, agentName: agentMeta.name });

          const systemPrompt = agentMeta.instructions || "You are a helpful AI assistant.";
          const agentEnabledTools: string[] = Array.isArray(agentMeta.tools)
            ? (agentMeta.tools as string[]) : [];

          // Auto-retrieve context-mode integrations (RAGFlow knowledge bases) before AI call
          const collectedContextSources: Array<{ content: string; documentName: string; score: number }> = [];
          for (const ci of contextIntegrations) {
            if (!ci.isActive || ci.provider !== "ragflow") continue;
            try {
              const raw = JSON.parse(decrypt(ci.credentialsEncrypted));
              const chunks = await retrieveRAGFlowContext(content.trim(), { baseUrl: raw.baseUrl, apiKey: raw.apiKey });
              collectedContextSources.push(...chunks);
            } catch { /* skip unavailable context integrations */ }
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

              for (const toolCall of result.toolCalls) {
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

                  // Capture RAGFlow sources
                  if (toolCall.name.startsWith("ragflow_query") && toolResult && typeof toolResult === "object") {
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
            conversationId: req.params.id,
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

  app.post("/api/conversations/:convId/messages/:msgId/confirm", async (req, res) => {
    const { approved } = req.body as { approved: boolean };
    const { convId, msgId } = req.params;

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
    const ws = await storage.getWorkspaceBySlug(req.params.slug);
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    res.json(ws);
  });

  // ── Member management (admin only) ────────────────────────────────────────
  app.get("/api/workspaces/:id/members", requireAdmin, async (req, res) => {
    const members = await storage.listWorkspaceMembers(req.params.id);
    res.json(members);
  });

  app.post("/api/workspaces/:id/members", requireAdmin, async (req, res) => {
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
    await storage.addWorkspaceMember(req.params.id, user.id, role ?? "member");
    res.json({ ok: true, userId: user.id });
  });

  app.delete("/api/workspaces/:id/members/:userId", requireAdmin, async (req, res) => {
    await storage.removeWorkspaceMember(req.params.id, req.params.userId);
    res.json({ ok: true });
  });

  // ── Seed default admin on startup ─────────────────────────────────────────
  (async () => {
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin";
    const existing = await storage.getUserByUsername(adminUsername);
    if (!existing) {
      await storage.createUser({
        username: adminUsername,
        passwordHash: hashPassword(adminPassword),
        name: "Administrator",
        role: "admin",
      });
      console.log(`[auth] Default admin created: ${adminUsername} / ${adminPassword}`);
    }
  })();

  return httpServer;
}
