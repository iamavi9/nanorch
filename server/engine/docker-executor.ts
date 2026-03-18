import { spawn } from "child_process";
import * as readline from "readline";
import { storage } from "../storage";
import { decrypt } from "../lib/encryption";
import { executeCloudTool, type CloudCredentials } from "../cloud/executor";
import { getToolsForProvider, detectProviderFromToolName } from "../cloud/tools";
import { sanitizeToolArgs } from "../lib/mountAllowlist";
import { taskLogEmitter } from "./emitter";
import type { Orchestrator, Agent } from "@shared/schema";
import type { ProviderMessage } from "../providers";
import { executeCodeInSandbox } from "./sandbox-executor";

const MAX_TOOL_ROUNDS = 10;
const CONTAINER_TIMEOUT_MS = 180_000;

export function isDockerAvailable(): boolean {
  return !!process.env.DOCKER_SOCKET;
}

type LoadedCredential = CloudCredentials & { integrationId: string };

export async function executeTaskInDocker(taskId: string): Promise<void> {
  const task = await storage.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const orchestrator = await storage.getOrchestrator(task.orchestratorId);
  if (!orchestrator) throw new Error(`Orchestrator not found`);

  const agent = task.agentId ? await storage.getAgent(task.agentId) : null;

  await storage.updateTask(taskId, { status: "running", startedAt: new Date() });

  const log = async (level: "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>) => {
    const entry = await storage.createTaskLog({ taskId, level, message, metadata });
    taskLogEmitter.emit(`task:${taskId}`, { ...entry, timestamp: entry.timestamp ?? new Date() });
  };

  try {
    await log("info", `Task started in Docker sandbox — provider: ${orchestrator.provider}, model: ${orchestrator.model}`);

    const cloudCreds = await loadCloudCredentials(orchestrator.workspaceId, log);
    const availableTools = buildToolList(cloudCreds);

    if (availableTools.length > 0) {
      await log("info", `Cloud integrations: ${cloudCreds.map((c) => c.provider).join(", ")} (${availableTools.length} tools available)`);
    }

    const messages: ProviderMessage[] = [];

    if (agent?.memoryEnabled) {
      const memory = await storage.listAgentMemory(agent.id);
      if (memory.length > 0) {
        const memStr = memory.map((m) => `${m.key}: ${m.value}`).join("\n");
        messages.push({ role: "system", content: `Agent memory:\n${memStr}` });
      }
    }

    messages.push({ role: "user", content: task.input });

    const systemPrompt = buildSystemPrompt(orchestrator, agent, availableTools.length > 0);

    await log("info", `Spawning ephemeral container for agent${agent ? ` "${agent.name}"` : ""}`);

    let output = "";
    let toolRounds = 0;

    while (toolRounds <= MAX_TOOL_ROUNDS) {
      const roundResult = await runInContainer({
        taskId,
        round: toolRounds,
        orchestrator,
        agent,
        systemPrompt,
        messages,
        tools: availableTools,
        log,
      });

      if (roundResult.type === "result") {
        output = roundResult.output;
        taskLogEmitter.emit(`task:${taskId}:stream`, output);
        break;
      }

      if (roundResult.type === "tool_calls") {
        if (roundResult.assistantContent) {
          messages.push({ role: "assistant", content: roundResult.assistantContent });
        }

        for (const toolCall of roundResult.toolCalls) {
          if (toolCall.name === "code_interpreter") {
            const { language, code } = toolCall.arguments as { language: string; code: string };
            await log("info", `[container] Running ${language} code in sandbox`);
            try {
              const sandboxResult = await executeCodeInSandbox(language, code);
              const output = sandboxResult.exitCode === 0
                ? `exit_code: 0\nstdout:\n${sandboxResult.stdout || "(no output)"}`
                : `exit_code: ${sandboxResult.exitCode}\nstdout:\n${sandboxResult.stdout || "(no output)"}\nstderr:\n${sandboxResult.stderr || "(none)"}`;
              await log("info", `Sandbox execution completed (exit ${sandboxResult.exitCode})`);
              messages.push({ role: "user", content: `Tool code_interpreter result:\n${output}` });
            } catch (err: any) {
              await log("error", `Sandbox execution failed: ${err.message}`);
              messages.push({ role: "user", content: `Tool code_interpreter result: ERROR — ${err.message}` });
            }
            continue;
          }

          const cloudProvider = detectProviderFromToolName(toolCall.name);
          const safeArgs = sanitizeToolArgs(toolCall.arguments);
          await log("info", `[container] Calling tool: ${toolCall.name}`, { args: safeArgs });

          const matchedCred = cloudCreds.find((c) => c.provider === cloudProvider);
          if (!matchedCred) {
            const errMsg = `No active ${cloudProvider} integration found for this workspace`;
            await log("warn", errMsg);
            messages.push({ role: "user", content: `Tool ${toolCall.name} result: ERROR — ${errMsg}` });
            continue;
          }

          try {
            const toolResult = await executeCloudTool(toolCall.name, toolCall.arguments, matchedCred);
            await storage.touchCloudIntegration(matchedCred.integrationId);
            const resultStr = JSON.stringify(toolResult, null, 2);
            await log("info", `Tool ${toolCall.name} completed`, { resultLength: resultStr.length });
            messages.push({ role: "user", content: `Tool ${toolCall.name} result:\n${resultStr}` });
          } catch (toolErr: any) {
            const errMsg = toolErr?.message ?? String(toolErr);
            await log("error", `Tool ${toolCall.name} failed: ${errMsg}`);
            messages.push({ role: "user", content: `Tool ${toolCall.name} result: ERROR — ${errMsg}` });
          }
        }

        toolRounds++;
        continue;
      }

      break;
    }

    if (!output && toolRounds >= MAX_TOOL_ROUNDS) {
      await log("warn", `Max tool rounds (${MAX_TOOL_ROUNDS}) reached`);
      const finalResult = await runInContainer({
        taskId,
        round: toolRounds,
        orchestrator,
        agent,
        systemPrompt,
        messages: [...messages, { role: "user", content: "Please provide your final answer based on the tool results above." }],
        tools: [],
        log,
      });
      if (finalResult.type === "result") {
        output = finalResult.output;
        taskLogEmitter.emit(`task:${taskId}:stream`, output);
      }
    }

    await log("info", `Task completed in sandbox — output length: ${output.length} chars`);

    if (agent?.memoryEnabled && agent) {
      await storage.setAgentMemory(agent.id, `last_output_${Date.now()}`, output.slice(0, 500));
    }

    await storage.updateTask(taskId, {
      status: "completed",
      output,
      completedAt: new Date(),
    });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await log("error", `Task failed in sandbox: ${message}`);
    await storage.updateTask(taskId, {
      status: "failed",
      errorMessage: message,
      completedAt: new Date(),
    });
  }
}

type ContainerResult =
  | { type: "result"; output: string }
  | { type: "tool_calls"; toolCalls: Array<{ id: string; name: string; arguments: Record<string, string> }>; assistantContent: string };

async function runInContainer(opts: {
  taskId: string;
  round: number;
  orchestrator: Orchestrator;
  agent: Agent | null;
  systemPrompt: string;
  messages: ProviderMessage[];
  tools: ReturnType<typeof buildToolList>;
  log: (level: "info" | "warn" | "error", msg: string) => Promise<void>;
}): Promise<ContainerResult> {
  const { taskId, round, orchestrator, agent, systemPrompt, messages, tools, log } = opts;

  const agentImage = process.env.AGENT_IMAGE ?? "nanoorch-agent:latest";

  const messagesB64 = Buffer.from(JSON.stringify(messages)).toString("base64");
  const toolsB64 = Buffer.from(JSON.stringify(tools)).toString("base64");

  const envArgs: string[] = [
    "--env", `TASK_ID=${taskId}`,
    "--env", `PROVIDER=${orchestrator.provider}`,
    "--env", `MODEL=${orchestrator.model}`,
    "--env", `MAX_TOKENS=${agent?.maxTokens ?? 4096}`,
    "--env", `TEMPERATURE=${agent?.temperature ?? 70}`,
    "--env", `SYSTEM_PROMPT=${systemPrompt}`,
    "--env", `MESSAGES_JSON=${messagesB64}`,
    "--env", `TOOLS_JSON=${toolsB64}`,
  ];

  const apiKeyEnvs = buildApiKeyEnvArgs();
  envArgs.push(...apiKeyEnvs);

  const containerName = `nanoorch-agent-${taskId.slice(0, 8)}-r${round}`;

  const dockerArgs = [
    "run", "--rm",
    "--name", containerName,
    "--memory", "512m",
    "--cpus", "0.5",
    "--network", "bridge",
    ...envArgs,
    agentImage,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const rl = readline.createInterface({ input: proc.stdout! });
    let containerResult: ContainerResult | null = null;
    let timedOut = false;

    const timer = setTimeout(async () => {
      timedOut = true;
      proc.kill("SIGKILL");
      await log("error", `Container ${containerName} timed out after ${CONTAINER_TIMEOUT_MS / 1000}s`);
      reject(new Error(`Container timed out`));
    }, CONTAINER_TIMEOUT_MS);

    rl.on("line", async (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === "log") {
          await log(parsed.level ?? "info", `[sandbox] ${parsed.message}`);
        } else if (parsed.type === "result") {
          containerResult = { type: "result", output: parsed.output ?? "" };
        } else if (parsed.type === "tool_calls") {
          containerResult = {
            type: "tool_calls",
            toolCalls: parsed.toolCalls ?? [],
            assistantContent: parsed.assistantContent ?? "",
          };
        } else if (parsed.type === "error") {
          reject(new Error(parsed.message ?? "Container error"));
        }
      } catch {
        await log("warn", `[sandbox] non-JSON output: ${line.slice(0, 200)}`);
      }
    });

    proc.stderr!.on("data", async (data) => {
      const text = data.toString().trim();
      if (text) await log("warn", `[sandbox stderr] ${text.slice(0, 500)}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (containerResult) {
        resolve(containerResult);
      } else if (code !== 0) {
        reject(new Error(`Container exited with code ${code}`));
      } else {
        reject(new Error("Container exited without producing output"));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn container: ${err.message}`));
    });
  });
}

function buildApiKeyEnvArgs(): string[] {
  const args: string[] = [];
  const keys: Array<[string, string]> = [
    ["OPENAI_API_KEY", process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? ""],
    ["OPENAI_BASE_URL", process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1"],
    ["ANTHROPIC_API_KEY", process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? ""],
    ["ANTHROPIC_BASE_URL", process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"],
    ["GEMINI_API_KEY", process.env.AI_INTEGRATIONS_GEMINI_API_KEY ?? ""],
    ["GEMINI_BASE_URL", process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com"],
  ];
  for (const [k, v] of keys) {
    if (v) args.push("--env", `${k}=${v}`);
  }
  return args;
}

async function loadCloudCredentials(
  workspaceId: string,
  log: (level: "info" | "warn" | "error", msg: string) => Promise<void>
): Promise<LoadedCredential[]> {
  const integrations = await storage.getCloudIntegrationsForWorkspace(workspaceId);
  const loaded: LoadedCredential[] = [];

  for (const integration of integrations) {
    try {
      const decrypted = decrypt(integration.credentialsEncrypted);
      const raw = JSON.parse(decrypted);

      if (integration.provider === "aws") {
        loaded.push({
          integrationId: integration.id,
          provider: "aws",
          credentials: {
            accessKeyId: raw.accessKeyId,
            secretAccessKey: raw.secretAccessKey,
            region: raw.region,
          },
        });
      } else if (integration.provider === "gcp") {
        loaded.push({
          integrationId: integration.id,
          provider: "gcp",
          credentials: { serviceAccountJson: raw },
        });
      } else if (integration.provider === "azure") {
        loaded.push({
          integrationId: integration.id,
          provider: "azure",
          credentials: {
            clientId: raw.clientId,
            clientSecret: raw.clientSecret,
            tenantId: raw.tenantId,
            subscriptionId: raw.subscriptionId,
          },
        });
      } else if (integration.provider === "ragflow") {
        loaded.push({
          integrationId: integration.id,
          provider: "ragflow",
          credentials: {
            baseUrl: raw.baseUrl,
            apiKey: raw.apiKey,
          },
        });
      } else if (integration.provider === "jira") {
        loaded.push({
          integrationId: integration.id,
          provider: "jira",
          credentials: {
            baseUrl: raw.baseUrl,
            email: raw.email,
            apiToken: raw.apiToken,
            defaultProjectKey: raw.defaultProjectKey,
          },
        });
      } else if (integration.provider === "github") {
        loaded.push({
          integrationId: integration.id,
          provider: "github",
          credentials: {
            token: raw.token,
            defaultOwner: raw.defaultOwner,
          },
        });
      } else if (integration.provider === "gitlab") {
        loaded.push({
          integrationId: integration.id,
          provider: "gitlab",
          credentials: {
            baseUrl: raw.baseUrl,
            token: raw.token,
            defaultProjectId: raw.defaultProjectId,
          },
        });
      } else if (integration.provider === "teams") {
        loaded.push({
          integrationId: integration.id,
          provider: "teams",
          credentials: { webhookUrl: raw.webhookUrl },
        });
      }
    } catch {
      await log("warn", `Failed to load credentials for integration "${integration.name}" — skipping`);
    }
  }

  return loaded;
}

function buildToolList(creds: LoadedCredential[]) {
  const tools: ReturnType<typeof getToolsForProvider> = [];
  for (const cred of creds) {
    tools.push(...getToolsForProvider(cred.provider));
  }
  return tools;
}

function buildSystemPrompt(orchestrator: Orchestrator, agent: Agent | null, hasCloudTools: boolean): string {
  const parts: string[] = [];

  if (orchestrator.systemPrompt) {
    parts.push(`Orchestrator Instructions:\n${orchestrator.systemPrompt}`);
  }

  if (agent?.instructions) {
    parts.push(`Agent Instructions:\n${agent.instructions}`);
  }

  if (hasCloudTools) {
    parts.push(
      `You have access to tools for cloud providers and developer platforms (AWS, GCP, Azure, RAGFlow, Jira, GitHub, GitLab). ` +
      `When the user asks about resources or operations on any of these platforms, use the appropriate tool to fetch real data. ` +
      `Always summarize tool results in a clear, human-readable format.`
    );
  }

  if (parts.length === 0) {
    parts.push("You are a helpful AI assistant.");
  }

  return parts.join("\n\n");
}
