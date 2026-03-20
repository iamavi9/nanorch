import cron from "node-cron";
import { storage } from "../storage";
import type { Agent } from "@shared/schema";
import { dispatchNotification } from "./notifier";

const heartbeatJobs = new Map<string, ReturnType<typeof cron.schedule>>();

function minutesToCron(minutes: number): string {
  if (minutes <= 0) return "";
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.floor(minutes / 60);
  return `0 */${hours} * * *`;
}

async function fireHeartbeat(agentId: string): Promise<string | null> {
  const agent = await storage.getAgent(agentId);
  if (!agent || !agent.heartbeatEnabled) return null;

  const orchestrator = await storage.getOrchestrator(agent.orchestratorId);
  if (!orchestrator || orchestrator.status === "paused") {
    console.log(`[heartbeat] Skipping agent "${agent.name}" — orchestrator is paused`);
    return null;
  }

  const silencePhrase = agent.heartbeatSilencePhrase ?? "HEARTBEAT_OK";
  const checklist = agent.heartbeatChecklist ?? "";

  const heartbeatInput = [
    `[HEARTBEAT TASK — ${new Date().toISOString()}]`,
    checklist
      ? `Follow this checklist strictly. Do not infer or repeat old tasks from prior chats:\n\n${checklist}`
      : "Perform a general status check. Report only if something needs attention.",
    `If nothing needs attention, reply with exactly: ${silencePhrase}`,
  ].join("\n\n");

  const task = await storage.createTask({
    orchestratorId: agent.orchestratorId,
    agentId: agent.id,
    input: heartbeatInput,
    status: "pending",
    intent: "conversational",
    priority: 3,
    isHeartbeat: true,
    notifyChannelId: (agent as any).heartbeatNotifyChannelId ?? undefined,
  });

  await storage.updateAgentHeartbeatLastFired(agent.id);

  console.log(`[heartbeat] Fired for agent "${agent.name}" → task ${task.id}`);

  dispatchNotification(orchestrator.id, "heartbeat.fired", {
    agentId: agent.id,
    agentName: agent.name,
    taskId: task.id,
  }).catch(console.error);

  return task.id;
}

export function registerHeartbeatJob(agent: Agent) {
  unregisterHeartbeatJob(agent.id);

  if (!agent.heartbeatEnabled) return;

  const intervalMinutes = agent.heartbeatIntervalMinutes ?? 30;
  const cronExpr = minutesToCron(intervalMinutes);

  if (!cronExpr || !cron.validate(cronExpr)) {
    console.warn(`[heartbeat] Invalid interval for agent "${agent.name}": ${intervalMinutes}m`);
    return;
  }

  const task = cron.schedule(cronExpr, () => {
    fireHeartbeat(agent.id).catch(console.error);
  });

  heartbeatJobs.set(agent.id, task);
  console.log(`[heartbeat] Registered agent "${agent.name}" — every ${intervalMinutes}m (${cronExpr})`);
}

export function unregisterHeartbeatJob(agentId: string) {
  const task = heartbeatJobs.get(agentId);
  if (task) {
    task.stop();
    heartbeatJobs.delete(agentId);
  }
}

export async function fireHeartbeatNow(agentId: string): Promise<string> {
  const agent = await storage.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  if (!agent.heartbeatEnabled) throw new Error("Heartbeat is not enabled for this agent");

  const taskId = await fireHeartbeat(agentId);
  return taskId ?? "";
}

export async function startHeartbeats() {
  try {
    const agentsWithHeartbeat = await storage.listAgentsWithHeartbeat();
    for (const agent of agentsWithHeartbeat) {
      registerHeartbeatJob(agent);
    }
    console.log(`[heartbeat] Started with ${agentsWithHeartbeat.length} active heartbeat(s)`);
  } catch (err) {
    console.error("[heartbeat] Failed to start:", err);
  }
}
