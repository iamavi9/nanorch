import { storage } from "../storage";
import { runAgent } from "../providers";
import type { ProviderMessage, ToolDefinition } from "../providers";
import type { Orchestrator, Agent } from "@shared/schema";
import { taskLogEmitter } from "./emitter";
import { decrypt } from "../lib/encryption";
import { executeCloudTool, type CloudCredentials } from "../cloud/executor";
import { getToolsForProvider, detectProviderFromToolName, CODE_INTERPRETER_TOOL } from "../cloud/tools";
import { sanitizeToolArgs } from "../lib/mountAllowlist";
import { isDockerAvailable, executeTaskInDocker } from "./docker-executor";
import { runCode } from "./sandbox-executor";

const MAX_TOOL_ROUNDS = 10;

export async function executeTask(taskId: string): Promise<void> {
  const taskCheck = await storage.getTask(taskId);
  if (isDockerAvailable() && taskCheck?.intent === "action") {
    return executeTaskInDocker(taskId);
  }

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
    await log("info", `Task started — provider: ${orchestrator.provider}, model: ${orchestrator.model}`);

    const cloudCreds = await loadCloudCredentials(orchestrator.workspaceId, log);
    const availableTools = buildToolList(cloudCreds, task.intent === "code_execution");

    if (availableTools.length > 0) {
      await log("info", `Cloud integrations active: ${cloudCreds.map((c) => c.provider).join(", ")} (${availableTools.length} tools available)`);
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

    await log("info", `Running agent${agent ? ` "${agent.name}"` : ""} with ${messages.length} message(s)`);

    let output = "";

    if (availableTools.length === 0) {
      const result = await runAgent({
        provider: orchestrator.provider,
        model: orchestrator.model,
        baseUrl: orchestrator.baseUrl,
        systemPrompt,
        messages,
        maxTokens: agent?.maxTokens ?? 4096,
        temperature: agent?.temperature ?? 70,
        onChunk: (chunk) => {
          taskLogEmitter.emit(`task:${taskId}:stream`, chunk);
        },
      });
      output = result.content;
    } else {
      let toolRounds = 0;
      let done = false;

      while (!done && toolRounds < MAX_TOOL_ROUNDS) {
        const result = await runAgent({
          provider: orchestrator.provider,
          model: orchestrator.model,
          baseUrl: orchestrator.baseUrl,
          systemPrompt,
          messages,
          maxTokens: agent?.maxTokens ?? 4096,
          temperature: agent?.temperature ?? 70,
          tools: availableTools,
        });

        if (!result.toolCalls || result.toolCalls.length === 0) {
          output = result.content;
          taskLogEmitter.emit(`task:${taskId}:stream`, output);
          done = true;
          break;
        }

        if (result.content) {
          messages.push({ role: "assistant", content: result.content });
        }

        for (const toolCall of result.toolCalls) {
          if (toolCall.name === "code_interpreter") {
            const { language, code } = toolCall.arguments as { language: string; code: string };
            const sandboxTimeout = agent?.sandboxTimeoutSeconds ?? undefined;
            await log("info", `Running ${language} code${sandboxTimeout ? ` (timeout: ${sandboxTimeout}s)` : ""}`);
            try {
              const sandboxResult = await runCode(language, code, sandboxTimeout);
              const output = sandboxResult.exitCode === 0
                ? `exit_code: 0\nstdout:\n${sandboxResult.stdout || "(no output)"}`
                : `exit_code: ${sandboxResult.exitCode}\nstdout:\n${sandboxResult.stdout || "(no output)"}\nstderr:\n${sandboxResult.stderr || "(none)"}`;
              await log("info", `Code execution completed (exit ${sandboxResult.exitCode})`);
              messages.push({ role: "user", content: `Tool code_interpreter result:\n${output}` });
            } catch (err: any) {
              await log("error", `Code execution failed: ${err.message}`);
              messages.push({ role: "user", content: `Tool code_interpreter result: ERROR — ${err?.message ?? String(err)}` });
            }
            continue;
          }

          const cloudProvider = detectProviderFromToolName(toolCall.name);
          const safeArgs = sanitizeToolArgs(toolCall.arguments);
          await log("info", `Calling tool: ${toolCall.name}`, { args: safeArgs });

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
      }

      if (!done) {
        await log("warn", `Max tool rounds (${MAX_TOOL_ROUNDS}) reached — requesting final answer`);
        const finalResult = await runAgent({
          provider: orchestrator.provider,
          model: orchestrator.model,
          baseUrl: orchestrator.baseUrl,
          systemPrompt,
          messages: [...messages, { role: "user", content: "Please provide your final answer based on the tool results above." }],
          maxTokens: agent?.maxTokens ?? 4096,
          temperature: agent?.temperature ?? 70,
          onChunk: (chunk) => {
            taskLogEmitter.emit(`task:${taskId}:stream`, chunk);
          },
        });
        output = finalResult.content;
      }
    }

    await log("info", `Task completed — output length: ${output.length} chars`);

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
    await log("error", `Task failed: ${message}`);
    await storage.updateTask(taskId, {
      status: "failed",
      errorMessage: message,
      completedAt: new Date(),
    });
  }
}

interface LoadedCredential extends CloudCredentials {
  integrationId: string;
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
      }
    } catch {
      await log("warn", `Failed to load credentials for integration "${integration.name}" — skipping`);
    }
  }

  return loaded;
}

function buildToolList(creds: LoadedCredential[], includeCodeInterpreter = false): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (includeCodeInterpreter) {
    tools.push(CODE_INTERPRETER_TOOL);
  }
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
      `You have access to cloud tools for AWS, GCP, and/or Azure. When the user asks about cloud resources, ` +
      `use the appropriate tool to fetch real data and provide accurate, up-to-date information. ` +
      `Always summarize tool results in a clear, human-readable format.`
    );
  }

  if (parts.length === 0) {
    parts.push("You are a helpful AI assistant.");
  }

  return parts.join("\n\n");
}
