import { storage } from "../storage";
import { decrypt } from "../lib/encryption";
import type { CloudCredentials } from "../cloud/executor";
import { getToolsForProvider } from "../cloud/tools";
import type { Orchestrator, Agent } from "@shared/schema";

export type LoadedCredential = CloudCredentials & { integrationId: string };

export async function loadCloudCredentials(
  workspaceId: string,
  log: (level: "info" | "warn" | "error", msg: string) => Promise<void>,
): Promise<LoadedCredential[]> {
  const integrations = await storage.getCloudIntegrationsForWorkspace(workspaceId);
  const loaded: LoadedCredential[] = [];

  for (const integration of integrations) {
    try {
      const decrypted = decrypt(integration.credentialsEncrypted);
      const raw = JSON.parse(decrypted);

      if (integration.provider === "aws") {
        loaded.push({ integrationId: integration.id, provider: "aws", credentials: { accessKeyId: raw.accessKeyId, secretAccessKey: raw.secretAccessKey, region: raw.region } });
      } else if (integration.provider === "gcp") {
        loaded.push({ integrationId: integration.id, provider: "gcp", credentials: { serviceAccountJson: raw } });
      } else if (integration.provider === "azure") {
        loaded.push({ integrationId: integration.id, provider: "azure", credentials: { clientId: raw.clientId, clientSecret: raw.clientSecret, tenantId: raw.tenantId, subscriptionId: raw.subscriptionId } });
      } else if (integration.provider === "ragflow") {
        loaded.push({ integrationId: integration.id, provider: "ragflow", credentials: { baseUrl: raw.baseUrl, apiKey: raw.apiKey } });
      } else if (integration.provider === "jira") {
        loaded.push({ integrationId: integration.id, provider: "jira", credentials: { baseUrl: raw.baseUrl, email: raw.email, apiToken: raw.apiToken, defaultProjectKey: raw.defaultProjectKey } });
      } else if (integration.provider === "github") {
        loaded.push({ integrationId: integration.id, provider: "github", credentials: { token: raw.token, defaultOwner: raw.defaultOwner } });
      } else if (integration.provider === "gitlab") {
        loaded.push({ integrationId: integration.id, provider: "gitlab", credentials: { baseUrl: raw.baseUrl, token: raw.token, defaultProjectId: raw.defaultProjectId } });
      } else if (integration.provider === "teams") {
        loaded.push({ integrationId: integration.id, provider: "teams", credentials: { webhookUrl: raw.webhookUrl } });
      } else if (integration.provider === "slack") {
        loaded.push({ integrationId: integration.id, provider: "slack", credentials: { botToken: raw.botToken, defaultChannel: raw.defaultChannel } });
      } else if (integration.provider === "google_chat") {
        loaded.push({ integrationId: integration.id, provider: "google_chat", credentials: { webhookUrl: raw.webhookUrl } });
      }
    } catch {
      await log("warn", `Failed to load credentials for integration "${integration.name}" — skipping`);
    }
  }

  return loaded;
}

export function buildToolList(creds: LoadedCredential[]): ReturnType<typeof getToolsForProvider> {
  const tools: ReturnType<typeof getToolsForProvider> = [];
  for (const cred of creds) {
    tools.push(...getToolsForProvider(cred.provider));
  }
  return tools;
}

export function buildSystemPrompt(orchestrator: Orchestrator, agent: Agent | null, hasCloudTools: boolean): string {
  const parts: string[] = [];

  if (orchestrator.systemPrompt) {
    parts.push(`Orchestrator Instructions:\n${orchestrator.systemPrompt}`);
  }

  if (agent?.instructions) {
    parts.push(`Agent Instructions:\n${agent.instructions}`);
  }

  if (hasCloudTools) {
    parts.push(
      `You have access to tools for cloud providers, developer platforms, and messaging services ` +
      `(AWS, GCP, Azure, RAGFlow, Jira, GitHub, GitLab, MS Teams, Slack, Google Chat). ` +
      `When the user asks about resources or operations on any of these platforms, use the appropriate ` +
      `tool to fetch real data or send messages. Always summarize tool results in a clear, human-readable format.`,
    );
  }

  if (parts.length === 0) {
    parts.push("You are a helpful AI assistant.");
  }

  return parts.join("\n\n");
}
