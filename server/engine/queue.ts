import { storage } from "../storage";
import { executeTask } from "./executor";

let isRunning = false;
const runningTasks = new Set<string>();

export function startQueueWorker() {
  if (isRunning) return;
  isRunning = true;
  processQueue();
}

async function processQueue() {
  while (true) {
    try {
      const pendingTasks = await storage.listPendingTasks();

      for (const task of pendingTasks) {
        if (runningTasks.has(task.id)) continue;

        const orchestrator = await storage.getOrchestrator(task.orchestratorId);
        if (!orchestrator || orchestrator.status === "paused") continue;

        const maxConcurrent = orchestrator.maxConcurrency ?? 3;
        const runningForOrchestrator = Array.from(runningTasks).filter((id) => id.startsWith(orchestrator.id)).length;
        if (runningForOrchestrator >= maxConcurrent) continue;

        runningTasks.add(task.id);
        executeTask(task.id)
          .catch((err) => console.error(`Queue: task ${task.id} failed:`, err))
          .finally(() => runningTasks.delete(task.id));
      }
    } catch (err) {
      console.error("Queue worker error:", err);
    }

    await sleep(2000);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
