import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { S3Client, ListBucketsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { Storage } from "@google-cloud/storage";
import { google } from "googleapis";
import { ClientSecretCredential } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import { ComputeManagementClient } from "@azure/arm-compute";
import { StorageManagementClient } from "@azure/arm-storage";

export interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export interface GCPCredentials {
  serviceAccountJson: Record<string, string>;
}

export interface AzureCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  subscriptionId: string;
}

export interface RAGFlowCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
  defaultProjectKey?: string;
  tokenType?: string;
}

export interface GitHubCredentials {
  token: string;
  defaultOwner?: string;
}

export interface GitLabCredentials {
  baseUrl: string;
  token: string;
  defaultProjectId?: string;
}

export interface TeamsCredentials {
  webhookUrl: string;
}

export interface SlackCredentials {
  botToken: string;
  defaultChannel?: string;
}

export interface GoogleChatCredentials {
  webhookUrl: string;
}

export interface ServiceNowCredentials {
  instanceUrl: string;
  username: string;
  password: string;
}

export type CloudCredentials =
  | { provider: "aws"; credentials: AWSCredentials }
  | { provider: "gcp"; credentials: GCPCredentials }
  | { provider: "azure"; credentials: AzureCredentials }
  | { provider: "ragflow"; credentials: RAGFlowCredentials }
  | { provider: "jira"; credentials: JiraCredentials }
  | { provider: "github"; credentials: GitHubCredentials }
  | { provider: "gitlab"; credentials: GitLabCredentials }
  | { provider: "teams"; credentials: TeamsCredentials }
  | { provider: "slack"; credentials: SlackCredentials }
  | { provider: "google_chat"; credentials: GoogleChatCredentials }
  | { provider: "servicenow"; credentials: ServiceNowCredentials };

export async function validateCredentials(creds: CloudCredentials): Promise<{ ok: boolean; detail: string }> {
  try {
    if (creds.provider === "aws") {
      const { accessKeyId, secretAccessKey, region } = creds.credentials;
      const sts = new STSClient({ region: region ?? "us-east-1", credentials: { accessKeyId, secretAccessKey } });
      const res = await sts.send(new GetCallerIdentityCommand({}));
      return { ok: true, detail: `AWS identity: ${res.Arn}` };
    }
    if (creds.provider === "gcp") {
      const auth = new google.auth.GoogleAuth({
        credentials: creds.credentials.serviceAccountJson as any,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      return { ok: !!token.token, detail: "GCP credentials valid" };
    }
    if (creds.provider === "azure") {
      const { clientId, clientSecret, tenantId, subscriptionId } = creds.credentials;
      const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
      await credential.getToken("https://management.azure.com/.default");
      return { ok: true, detail: `Azure subscription: ${subscriptionId}` };
    }
    if (creds.provider === "ragflow") {
      const { baseUrl, apiKey } = creds.credentials;
      if (!baseUrl) throw new Error("RAGFlow Base URL is required");
      if (!apiKey) throw new Error("RAGFlow API Key is required");
      const url = `${baseUrl.replace(/\/$/, "")}/api/v1/datasets?page=1&page_size=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`RAGFlow responded with ${res.status}`);
      const data = await res.json() as any;
      const count = data?.data?.total ?? "unknown";
      return { ok: true, detail: `Connected to RAGFlow — ${count} dataset(s) found` };
    }
    if (creds.provider === "jira") {
      const { baseUrl, email, apiToken } = creds.credentials;
      if (!baseUrl) throw new Error("Jira Base URL is required");
      if (!email) throw new Error("Jira email is required");
      if (!apiToken) throw new Error("Jira API token is required");
      const base = baseUrl.replace(/\/$/, "");
      const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
      const res = await fetch(`${base}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Jira responded with ${res.status}`);
      const data = await res.json() as any;
      return { ok: true, detail: `Connected as ${data.displayName ?? data.emailAddress} (${data.accountId})` };
    }
    if (creds.provider === "github") {
      const { token } = creds.credentials;
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub responded with ${res.status}`);
      const data = await res.json() as any;
      return { ok: true, detail: `Connected as ${data.login} (${data.name ?? "no name"})` };
    }
    if (creds.provider === "gitlab") {
      const { baseUrl, token } = creds.credentials;
      if (!baseUrl) throw new Error("GitLab Base URL is required");
      if (!token) throw new Error("GitLab token is required");
      const base = baseUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/api/v4/user`, {
        headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`GitLab responded with ${res.status}`);
      const data = await res.json() as any;
      return { ok: true, detail: `Connected as ${data.username} (${data.name})` };
    }
    if (creds.provider === "teams") {
      const { webhookUrl } = creds.credentials;
      if (!webhookUrl) throw new Error("Teams webhook URL is required");
      if (!webhookUrl.startsWith("https://")) {
        throw new Error("Teams webhook URL must start with https://");
      }
      const isConnector = webhookUrl.includes("webhook.office.com");
      const testBody = isConnector
        ? {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            themeColor: "0076D7",
            summary: "NanoOrch connection test",
            sections: [{ activityTitle: "NanoOrch Connected", activityText: "Teams integration is working correctly.", markdown: true }],
          }
        : {
            type: "message",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: {
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.4",
                  body: [
                    { type: "TextBlock", text: "NanoOrch Connected", weight: "Bolder", size: "Large", wrap: true },
                    { type: "TextBlock", text: "Teams integration is working correctly.", wrap: true },
                  ],
                },
              },
            ],
          };
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testBody),
      });
      if (!res.ok) throw new Error(`Teams webhook responded with ${res.status}`);
      return { ok: true, detail: "Teams webhook is reachable and accepting messages" };
    }
    if (creds.provider === "slack") {
      const { botToken } = creds.credentials;
      if (!botToken) throw new Error("Slack bot token is required");
      if (!botToken.startsWith("xoxb-")) throw new Error("Slack bot token must start with xoxb-");
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
      });
      const data = await res.json() as any;
      if (!data.ok) throw new Error(`Slack auth failed: ${data.error}`);
      return { ok: true, detail: `Connected to Slack as @${data.user} (workspace: ${data.team})` };
    }
    if (creds.provider === "google_chat") {
      const { webhookUrl } = creds.credentials;
      if (!webhookUrl) throw new Error("Google Chat webhook URL is required");
      if (!webhookUrl.startsWith("https://chat.googleapis.com/")) throw new Error("Google Chat webhook URL must start with https://chat.googleapis.com/");
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "NanoOrch connection test — integration is working correctly." }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Google Chat webhook responded with ${res.status}`);
      return { ok: true, detail: "Google Chat webhook is reachable and accepting messages" };
    }
    if (creds.provider === "servicenow") {
      const { instanceUrl, username, password } = creds.credentials;
      if (!instanceUrl) throw new Error("ServiceNow Instance URL is required");
      if (!username) throw new Error("ServiceNow username is required");
      if (!password) throw new Error("ServiceNow password is required");
      const base = instanceUrl.replace(/\/$/, "");
      const auth = Buffer.from(`${username}:${password}`).toString("base64");
      const res = await fetch(`${base}/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(username)}&sysparm_limit=1&sysparm_fields=user_name,name,email`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`ServiceNow responded with ${res.status} — check instance URL and credentials`);
      const data = await res.json() as any;
      const user = data?.result?.[0];
      return { ok: true, detail: `Connected to ${base} as ${user?.name ?? username} (${user?.email ?? "no email"})` };
    }
    return { ok: false, detail: "Unknown provider" };
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? String(err) };
  }
}

export async function executeCloudTool(
  toolName: string,
  toolArgs: Record<string, string>,
  creds: CloudCredentials
): Promise<unknown> {
  if (creds.provider === "aws") {
    return executeAWSTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "gcp") {
    return executeGCPTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "azure") {
    return executeAzureTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "ragflow") {
    return executeRAGFlowTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "jira") {
    return executeJiraTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "github") {
    return executeGitHubTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "gitlab") {
    return executeGitLabTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "teams") {
    return executeTeamsTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "slack") {
    return executeSlackTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "google_chat") {
    return executeGoogleChatTool(toolName, toolArgs, creds.credentials);
  }
  if (creds.provider === "servicenow") {
    return executeServiceNowTool(toolName, toolArgs, creds.credentials);
  }
  throw new Error(`Unknown cloud provider`);
}

async function executeAWSTool(name: string, args: Record<string, string>, creds: AWSCredentials): Promise<unknown> {
  const region = args.region ?? creds.region ?? "us-east-1";
  const awsCreds = { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey };

  if (name === "aws_list_s3_buckets") {
    const s3 = new S3Client({ region, credentials: awsCreds });
    const res = await s3.send(new ListBucketsCommand({}));
    return { buckets: (res.Buckets ?? []).map((b) => ({ name: b.Name, createdAt: b.CreationDate })) };
  }

  if (name === "aws_list_s3_objects") {
    const s3 = new S3Client({ region, credentials: awsCreds });
    const res = await s3.send(new ListObjectsV2Command({ Bucket: args.bucket, Prefix: args.prefix, MaxKeys: 100 }));
    return { objects: (res.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size, lastModified: o.LastModified })) };
  }

  if (name === "aws_list_ec2_instances") {
    const ec2 = new EC2Client({ region, credentials: awsCreds });
    const res = await ec2.send(new DescribeInstancesCommand({}));
    const instances = (res.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => ({
      id: i.InstanceId,
      type: i.InstanceType,
      state: i.State?.Name,
      name: i.Tags?.find((t) => t.Key === "Name")?.Value,
      publicIp: i.PublicIpAddress,
      launchTime: i.LaunchTime,
    }));
    const stateFilter = args.state && args.state !== "all" ? args.state : null;
    return { instances: stateFilter ? instances.filter((i) => i.state === stateFilter) : instances };
  }

  if (name === "aws_list_lambda_functions") {
    const lambda = new LambdaClient({ region, credentials: awsCreds });
    const res = await lambda.send(new ListFunctionsCommand({}));
    return { functions: (res.Functions ?? []).map((f) => ({ name: f.FunctionName, runtime: f.Runtime, lastModified: f.LastModified, memory: f.MemorySize })) };
  }

  if (name === "aws_get_cloudwatch_logs") {
    const logs = new CloudWatchLogsClient({ region, credentials: awsCreds });
    const res = await logs.send(new FilterLogEventsCommand({
      logGroupName: args.logGroupName,
      limit: args.limit ? parseInt(args.limit) : 50,
    }));
    return { events: (res.events ?? []).map((e) => ({ timestamp: e.timestamp, message: e.message })) };
  }

  throw new Error(`Unknown AWS tool: ${name}`);
}

async function executeGCPTool(name: string, args: Record<string, string>, creds: GCPCredentials): Promise<unknown> {
  const projectId = args.projectId ?? (creds.serviceAccountJson.project_id as string);

  if (name === "gcp_list_storage_buckets") {
    const storage = new Storage({ credentials: creds.serviceAccountJson as any, projectId });
    const [buckets] = await storage.getBuckets();
    return { buckets: buckets.map((b) => ({ name: b.name, location: b.metadata?.location })) };
  }

  if (name === "gcp_list_compute_instances") {
    const auth = new google.auth.GoogleAuth({ credentials: creds.serviceAccountJson as any, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const compute = google.compute({ version: "v1", auth });
    const zone = args.zone ?? "-";
    const res = await compute.instances.aggregatedList({ project: projectId });
    const items = res.data.items ?? {};
    const instances: unknown[] = [];
    for (const [z, zoneData] of Object.entries(items)) {
      for (const inst of (zoneData as any).instances ?? []) {
        instances.push({ name: inst.name, zone: z.replace("zones/", ""), status: inst.status, machineType: inst.machineType?.split("/").pop() });
      }
    }
    return { instances };
  }

  if (name === "gcp_list_cloud_functions") {
    const auth = new google.auth.GoogleAuth({ credentials: creds.serviceAccountJson as any, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const cf = google.cloudfunctions({ version: "v2", auth });
    const region = args.region ?? "-";
    const res = await cf.projects.locations.functions.list({ parent: `projects/${projectId}/locations/${region}` });
    return { functions: (res.data.functions ?? []).map((f: any) => ({ name: f.name?.split("/").pop(), state: f.state, runtime: f.buildConfig?.runtime })) };
  }

  throw new Error(`Unknown GCP tool: ${name}`);
}

async function executeAzureTool(name: string, args: Record<string, string>, creds: AzureCredentials): Promise<unknown> {
  const { clientId, clientSecret, tenantId, subscriptionId } = creds;
  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

  if (name === "azure_list_resource_groups") {
    const client = new ResourceManagementClient(credential, subscriptionId);
    const groups: unknown[] = [];
    for await (const g of client.resourceGroups.list()) {
      groups.push({ name: g.name, location: g.location, provisioningState: g.properties?.provisioningState });
    }
    return { resourceGroups: groups };
  }

  if (name === "azure_list_virtual_machines") {
    const client = new ComputeManagementClient(credential, subscriptionId);
    const vms: unknown[] = [];
    if (args.resourceGroup) {
      for await (const vm of client.virtualMachines.list(args.resourceGroup)) {
        vms.push({ name: vm.name, location: vm.location, size: vm.hardwareProfile?.vmSize });
      }
    } else {
      for await (const vm of client.virtualMachines.listAll()) {
        vms.push({ name: vm.name, location: vm.location, size: vm.hardwareProfile?.vmSize });
      }
    }
    return { virtualMachines: vms };
  }

  if (name === "azure_list_storage_accounts") {
    const client = new StorageManagementClient(credential, subscriptionId);
    const accounts: unknown[] = [];
    if (args.resourceGroup) {
      for await (const acc of client.storageAccounts.listByResourceGroup(args.resourceGroup)) {
        accounts.push({ name: acc.name, location: acc.location, kind: acc.kind, sku: acc.sku?.name });
      }
    } else {
      for await (const acc of client.storageAccounts.list()) {
        accounts.push({ name: acc.name, location: acc.location, kind: acc.kind, sku: acc.sku?.name });
      }
    }
    return { storageAccounts: accounts };
  }

  throw new Error(`Unknown Azure tool: ${name}`);
}

function extractRAGFlowChunks(data: any): Array<{ content: string; score: number; documentName: string }> {
  const rawChunks: any[] = data?.data?.chunks ?? data?.data ?? [];
  return rawChunks.map((c: any) => ({
    content: c.content_with_weight ?? c.content ?? "",
    score: typeof c.similarity === "number" ? c.similarity
      : typeof c.score === "number" ? c.score
      : typeof c.vector_similarity === "number" ? c.vector_similarity : 0,
    documentName: c.doc_name ?? c.document_keyword ?? c.docnm_kwd ?? c.document_name ?? "",
  }));
}

async function executeRAGFlowTool(name: string, args: Record<string, string>, creds: RAGFlowCredentials): Promise<unknown> {
  const base = creds.baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" };

  if (name === "ragflow_list_datasets") {
    const res = await fetch(`${base}/api/v1/datasets?page=1&page_size=50`, { headers });
    if (!res.ok) throw new Error(`RAGFlow list datasets failed: ${res.status}`);
    const data = await res.json() as any;
    const datasets = (data?.data?.docs ?? data?.data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      documentCount: d.document_count ?? d.doc_num ?? 0,
      chunkCount: d.chunk_count ?? d.chunk_num ?? 0,
      description: d.description ?? "",
    }));
    return { datasets, total: data?.data?.total ?? datasets.length };
  }

  if (name === "ragflow_query_dataset") {
    const topK = parseInt(args.top_k ?? "5");
    const body = { question: args.question, dataset_ids: [args.dataset_id], top_k: topK };
    const res = await fetch(`${base}/api/v1/retrieval`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RAGFlow retrieval failed: ${res.status} — ${text}`);
    }
    const data = await res.json() as any;
    const chunks = extractRAGFlowChunks(data);
    return { question: args.question, chunks, total: chunks.length };
  }

  if (name === "ragflow_query_multiple_datasets") {
    const topK = parseInt(args.top_k ?? "5");
    const datasetIds = args.dataset_ids.split(",").map((s) => s.trim()).filter(Boolean);
    const body = { question: args.question, dataset_ids: datasetIds, top_k: topK };
    const res = await fetch(`${base}/api/v1/retrieval`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RAGFlow retrieval failed: ${res.status} — ${text}`);
    }
    const data = await res.json() as any;
    const chunks = extractRAGFlowChunks(data).map((c) => ({ ...c, datasetId: (data?.data?.chunks ?? []).find((r: any) => r.content_with_weight === c.content || r.content === c.content)?.kb_id }));
    return { question: args.question, chunks, total: chunks.length, datasetsQueried: datasetIds.length };
  }

  throw new Error(`Unknown RAGFlow tool: ${name}`);
}

async function executeJiraTool(name: string, args: Record<string, string>, creds: JiraCredentials): Promise<unknown> {
  const base = creds.baseUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json" };

  const jiraFetch = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira ${path} failed: ${res.status} — ${text}`);
    }
    return res.json();
  };

  if (name === "jira_list_projects") {
    const data = await jiraFetch("/rest/api/3/project?maxResults=50") as any;
    return { projects: (Array.isArray(data) ? data : data.values ?? []).map((p: any) => ({ id: p.id, key: p.key, name: p.name, type: p.projectTypeKey })) };
  }

  if (name === "jira_search_issues") {
    const max = parseInt(args.maxResults ?? "20");
    const data = await jiraFetch("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql: args.jql, maxResults: Math.min(max, 50), fields: ["summary", "status", "priority", "assignee", "issuetype", "created", "updated"] }),
    }) as any;
    return {
      total: data.total,
      issues: (data.issues ?? []).map((i: any) => ({
        key: i.key,
        summary: i.fields?.summary,
        status: i.fields?.status?.name,
        priority: i.fields?.priority?.name,
        assignee: i.fields?.assignee?.displayName ?? null,
        type: i.fields?.issuetype?.name,
        created: i.fields?.created,
        updated: i.fields?.updated,
      })),
    };
  }

  if (name === "jira_get_issue") {
    const data = await jiraFetch(`/rest/api/3/issue/${args.issueKey}`) as any;
    return {
      key: data.key,
      summary: data.fields?.summary,
      description: data.fields?.description,
      status: data.fields?.status?.name,
      priority: data.fields?.priority?.name,
      assignee: data.fields?.assignee?.displayName ?? null,
      reporter: data.fields?.reporter?.displayName ?? null,
      type: data.fields?.issuetype?.name,
      created: data.fields?.created,
      updated: data.fields?.updated,
      labels: data.fields?.labels ?? [],
    };
  }

  if (name === "jira_create_issue") {
    const projectKey = args.projectKey ?? creds.defaultProjectKey;
    if (!projectKey) throw new Error("projectKey is required");
    const body: Record<string, unknown> = {
      fields: {
        project: { key: projectKey },
        summary: args.summary,
        issuetype: { name: args.issueType },
        ...(args.description ? { description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: args.description }] }] } } : {}),
        ...(args.priority ? { priority: { name: args.priority } } : {}),
        ...(args.assignee ? { assignee: { accountId: args.assignee } } : {}),
      },
    };
    const data = await jiraFetch("/rest/api/3/issue", { method: "POST", body: JSON.stringify(body) }) as any;
    return { key: data.key, id: data.id, self: data.self };
  }

  if (name === "jira_update_issue") {
    const fields: Record<string, unknown> = {};
    if (args.summary) fields.summary = args.summary;
    if (args.priority) fields.priority = { name: args.priority };
    if (args.assignee) fields.assignee = { accountId: args.assignee };
    if (Object.keys(fields).length > 0) {
      await jiraFetch(`/rest/api/3/issue/${args.issueKey}`, { method: "PUT", body: JSON.stringify({ fields }) });
    }
    if (args.status) {
      const transitions = await jiraFetch(`/rest/api/3/issue/${args.issueKey}/transitions`) as any;
      const transition = (transitions.transitions ?? []).find((t: any) => t.name.toLowerCase() === args.status.toLowerCase());
      if (!transition) throw new Error(`No transition named '${args.status}' found for issue ${args.issueKey}`);
      await jiraFetch(`/rest/api/3/issue/${args.issueKey}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: transition.id } }) });
    }
    return { ok: true, issueKey: args.issueKey };
  }

  if (name === "jira_add_comment") {
    const data = await jiraFetch(`/rest/api/3/issue/${args.issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: args.comment }] }] } }),
    }) as any;
    return { commentId: data.id, issueKey: args.issueKey, created: data.created };
  }

  if (name === "jira_list_sprints") {
    const state = args.state ?? "active";
    const data = await jiraFetch(`/rest/agile/1.0/board/${args.boardId}/sprint?state=${state}`) as any;
    return { sprints: (data.values ?? []).map((s: any) => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate })) };
  }

  throw new Error(`Unknown Jira tool: ${name}`);
}

async function executeGitHubTool(name: string, args: Record<string, string>, creds: GitHubCredentials): Promise<unknown> {
  const base = "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${creds.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const ghFetch = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${path} failed: ${res.status} — ${text}`);
    }
    return res.json();
  };

  const owner = (v: string | undefined) => v ?? creds.defaultOwner ?? "";

  if (name === "github_list_repos") {
    const o = owner(args.owner);
    const type = args.type ?? "all";
    let data: any;
    if (o) {
      data = await ghFetch(`/orgs/${o}/repos?type=${type}&per_page=50`).catch(() => ghFetch(`/users/${o}/repos?type=${type}&per_page=50`));
    } else {
      data = await ghFetch(`/user/repos?type=${type}&per_page=50`);
    }
    return { repos: (data as any[]).map((r: any) => ({ name: r.name, fullName: r.full_name, private: r.private, stars: r.stargazers_count, language: r.language, updatedAt: r.updated_at })) };
  }

  if (name === "github_list_issues") {
    const o = owner(args.owner);
    const state = args.state ?? "open";
    const params = new URLSearchParams({ state, per_page: "30" });
    if (args.labels) params.set("labels", args.labels);
    const data = await ghFetch(`/repos/${o}/${args.repo}/issues?${params}`) as any[];
    return { issues: data.filter((i) => !i.pull_request).map((i: any) => ({ number: i.number, title: i.title, state: i.state, labels: (i.labels ?? []).map((l: any) => l.name), assignees: (i.assignees ?? []).map((a: any) => a.login), createdAt: i.created_at, updatedAt: i.updated_at })) };
  }

  if (name === "github_get_issue") {
    const o = owner(args.owner);
    const data = await ghFetch(`/repos/${o}/${args.repo}/issues/${args.issueNumber}`) as any;
    return { number: data.number, title: data.title, body: data.body, state: data.state, labels: (data.labels ?? []).map((l: any) => l.name), assignees: (data.assignees ?? []).map((a: any) => a.login), createdAt: data.created_at, updatedAt: data.updated_at };
  }

  if (name === "github_create_issue") {
    const o = owner(args.owner);
    const body: Record<string, unknown> = { title: args.title };
    if (args.body) body.body = args.body;
    if (args.labels) body.labels = args.labels.split(",").map((s) => s.trim()).filter(Boolean);
    if (args.assignees) body.assignees = args.assignees.split(",").map((s) => s.trim()).filter(Boolean);
    const data = await ghFetch(`/repos/${o}/${args.repo}/issues`, { method: "POST", body: JSON.stringify(body) }) as any;
    return { number: data.number, url: data.html_url, title: data.title };
  }

  if (name === "github_list_pull_requests") {
    const o = owner(args.owner);
    const params = new URLSearchParams({ state: args.state ?? "open", per_page: "30" });
    if (args.base) params.set("base", args.base);
    const data = await ghFetch(`/repos/${o}/${args.repo}/pulls?${params}`) as any[];
    return { pullRequests: data.map((p: any) => ({ number: p.number, title: p.title, state: p.state, head: p.head?.ref, base: p.base?.ref, author: p.user?.login, createdAt: p.created_at, updatedAt: p.updated_at })) };
  }

  if (name === "github_create_pull_request") {
    const o = owner(args.owner);
    const body: Record<string, unknown> = { title: args.title, head: args.head, base: args.base };
    if (args.body) body.body = args.body;
    const data = await ghFetch(`/repos/${o}/${args.repo}/pulls`, { method: "POST", body: JSON.stringify(body) }) as any;
    return { number: data.number, url: data.html_url, title: data.title };
  }

  if (name === "github_list_workflow_runs") {
    const o = owner(args.owner);
    const params = new URLSearchParams({ per_page: "20" });
    if (args.status) params.set("status", args.status);
    if (args.branch) params.set("branch", args.branch);
    const data = await ghFetch(`/repos/${o}/${args.repo}/actions/runs?${params}`) as any;
    return { runs: (data.workflow_runs ?? []).map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, createdAt: r.created_at, updatedAt: r.updated_at, url: r.html_url })) };
  }

  throw new Error(`Unknown GitHub tool: ${name}`);
}

async function executeGitLabTool(name: string, args: Record<string, string>, creds: GitLabCredentials): Promise<unknown> {
  const base = creds.baseUrl.replace(/\/$/, "");
  const headers = { "PRIVATE-TOKEN": creds.token, Accept: "application/json", "Content-Type": "application/json" };

  const glFetch = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}/api/v4${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab ${path} failed: ${res.status} — ${text}`);
    }
    return res.json();
  };

  const encodeId = (id: string) => encodeURIComponent(id);

  if (name === "gitlab_list_projects") {
    const params = new URLSearchParams({ per_page: "30", order_by: "last_activity_at" });
    if (args.search) params.set("search", args.search);
    if (args.owned === "true") params.set("owned", "true");
    const data = await glFetch(`/projects?${params}`) as any[];
    return { projects: data.map((p: any) => ({ id: p.id, name: p.name, path: p.path_with_namespace, visibility: p.visibility, lastActivity: p.last_activity_at, webUrl: p.web_url })) };
  }

  if (name === "gitlab_list_issues") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const params = new URLSearchParams({ per_page: "30", state: args.state ?? "opened" });
    if (args.labels) params.set("labels", args.labels);
    if (args.assigneeUsername) params.set("assignee_username", args.assigneeUsername);
    const data = await glFetch(`/projects/${encodeId(pid)}/issues?${params}`) as any[];
    return { issues: data.map((i: any) => ({ iid: i.iid, title: i.title, state: i.state, labels: i.labels ?? [], assignees: (i.assignees ?? []).map((a: any) => a.username), createdAt: i.created_at, updatedAt: i.updated_at, webUrl: i.web_url })) };
  }

  if (name === "gitlab_get_issue") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const data = await glFetch(`/projects/${encodeId(pid)}/issues/${args.issueIid}`) as any;
    return { iid: data.iid, title: data.title, description: data.description, state: data.state, labels: data.labels ?? [], assignees: (data.assignees ?? []).map((a: any) => a.username), author: data.author?.username, createdAt: data.created_at, updatedAt: data.updated_at, webUrl: data.web_url };
  }

  if (name === "gitlab_create_issue") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const body: Record<string, unknown> = { title: args.title };
    if (args.description) body.description = args.description;
    if (args.labels) body.labels = args.labels;
    if (args.assigneeUsernames) body.assignee_usernames = args.assigneeUsernames.split(",").map((s) => s.trim()).filter(Boolean);
    const data = await glFetch(`/projects/${encodeId(pid)}/issues`, { method: "POST", body: JSON.stringify(body) }) as any;
    return { iid: data.iid, title: data.title, webUrl: data.web_url };
  }

  if (name === "gitlab_list_merge_requests") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const params = new URLSearchParams({ per_page: "30", state: args.state ?? "opened" });
    if (args.targetBranch) params.set("target_branch", args.targetBranch);
    const data = await glFetch(`/projects/${encodeId(pid)}/merge_requests?${params}`) as any[];
    return { mergeRequests: data.map((m: any) => ({ iid: m.iid, title: m.title, state: m.state, sourceBranch: m.source_branch, targetBranch: m.target_branch, author: m.author?.username, createdAt: m.created_at, webUrl: m.web_url })) };
  }

  if (name === "gitlab_create_merge_request") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const body: Record<string, unknown> = { title: args.title, source_branch: args.sourceBranch, target_branch: args.targetBranch };
    if (args.description) body.description = args.description;
    const data = await glFetch(`/projects/${encodeId(pid)}/merge_requests`, { method: "POST", body: JSON.stringify(body) }) as any;
    return { iid: data.iid, title: data.title, webUrl: data.web_url };
  }

  if (name === "gitlab_list_pipelines") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const params = new URLSearchParams({ per_page: "20" });
    if (args.status) params.set("status", args.status);
    if (args.ref) params.set("ref", args.ref);
    const data = await glFetch(`/projects/${encodeId(pid)}/pipelines?${params}`) as any[];
    return { pipelines: data.map((p: any) => ({ id: p.id, status: p.status, ref: p.ref, sha: p.sha, createdAt: p.created_at, updatedAt: p.updated_at, webUrl: p.web_url })) };
  }

  if (name === "gitlab_trigger_pipeline") {
    const pid = args.projectId ?? creds.defaultProjectId ?? "";
    const data = await glFetch(`/projects/${encodeId(pid)}/pipeline`, { method: "POST", body: JSON.stringify({ ref: args.ref }) }) as any;
    return { id: data.id, status: data.status, ref: data.ref, webUrl: data.web_url };
  }

  throw new Error(`Unknown GitLab tool: ${name}`);
}

async function executeTeamsTool(name: string, args: Record<string, string>, creds: TeamsCredentials): Promise<unknown> {
  const { webhookUrl } = creds;

  // Detect URL type: old Office 365 Connectors vs new Power Automate Workflows
  const isConnector = webhookUrl.includes("webhook.office.com");

  const buildAdaptiveCard = (bodyBlocks: object[]) => ({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: bodyBlocks,
        },
      },
    ],
  });

  const postPayload = async (connectorBody: object, workflowBody: object) => {
    const body = isConnector ? connectorBody : workflowBody;
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Teams webhook failed: ${res.status} — ${text}`);
    }
    return { sent: true };
  };

  if (name === "teams_send_message") {
    return postPayload(
      {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: args.color ?? "0076D7",
        summary: args.text?.slice(0, 100) ?? "Message from NanoOrch",
        sections: [{ activityText: args.text, markdown: true }],
      },
      buildAdaptiveCard([
        { type: "TextBlock", text: args.text ?? "", wrap: true, size: "default" },
      ])
    );
  }

  if (name === "teams_send_notification") {
    const facts: Array<{ name: string; value: string }> = [];
    if (args.facts) {
      try {
        const parsed = JSON.parse(args.facts);
        for (const [k, v] of Object.entries(parsed)) {
          facts.push({ name: String(k), value: String(v) });
        }
      } catch {
        facts.push({ name: "Details", value: args.facts });
      }
    }

    // Adaptive Card body blocks for Workflows
    const acBlocks: object[] = [];
    if (args.title) acBlocks.push({ type: "TextBlock", text: args.title, weight: "Bolder", size: "Large", wrap: true });
    if (args.subtitle) acBlocks.push({ type: "TextBlock", text: args.subtitle, isSubtle: true, wrap: true });
    if (args.body) acBlocks.push({ type: "TextBlock", text: args.body, wrap: true, spacing: "Medium" });
    if (facts.length > 0) {
      acBlocks.push({
        type: "FactSet",
        facts: facts.map((f) => ({ title: f.name, value: f.value })),
        spacing: "Medium",
      });
    }
    if (args.actionUrl) {
      acBlocks.push({
        type: "ActionSet",
        spacing: "Medium",
        actions: [{ type: "Action.OpenUrl", title: args.actionLabel ?? "View", url: args.actionUrl }],
      });
    }

    return postPayload(
      {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: args.color ?? "0076D7",
        summary: args.title ?? "Notification from NanoOrch",
        sections: [
          {
            activityTitle: args.title ?? "Notification",
            activitySubtitle: args.subtitle ?? "",
            activityText: args.body ?? "",
            facts,
            markdown: true,
          },
        ],
        ...(args.actionUrl && args.actionLabel ? {
          potentialAction: [{
            "@type": "OpenUri",
            name: args.actionLabel,
            targets: [{ os: "default", uri: args.actionUrl }],
          }],
        } : {}),
      },
      buildAdaptiveCard(acBlocks.length > 0 ? acBlocks : [{ type: "TextBlock", text: "Notification from NanoOrch", wrap: true }])
    );
  }

  throw new Error(`Unknown Teams tool: ${name}`);
}

async function executeSlackTool(name: string, args: Record<string, string>, creds: SlackCredentials): Promise<unknown> {
  const channel = args.channel || creds.defaultChannel || "";
  if (!channel) throw new Error("No Slack channel specified and no default channel configured in integration");

  const postJson = async (body: object) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as any;
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return { sent: true, ts: data.ts, channel: data.channel };
  };

  if (name === "slack_send_message") {
    return postJson({ channel, text: args.text ?? "" });
  }

  if (name === "slack_send_notification") {
    const fields: Array<{ title: string; value: string; short: boolean }> = [];
    if (args.fields) {
      try {
        const parsed = JSON.parse(args.fields);
        for (const [k, v] of Object.entries(parsed)) {
          fields.push({ title: String(k), value: String(v), short: true });
        }
      } catch {
        fields.push({ title: "Details", value: args.fields, short: false });
      }
    }
    return postJson({
      channel,
      attachments: [
        {
          color: args.color ?? "good",
          title: args.title ?? "",
          text: args.body ?? "",
          fields,
          mrkdwn_in: ["text", "fields"],
        },
      ],
    });
  }

  throw new Error(`Unknown Slack tool: ${name}`);
}

async function executeGoogleChatTool(name: string, args: Record<string, string>, creds: GoogleChatCredentials): Promise<unknown> {
  const post = async (body: object) => {
    const res = await fetch(creds.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Chat webhook failed: ${res.status} — ${text}`);
    }
    return { sent: true };
  };

  if (name === "google_chat_send_message") {
    return post({ text: args.text ?? "" });
  }

  if (name === "google_chat_send_card") {
    const sections: object[] = [
      { widgets: [{ textParagraph: { text: args.body ?? "" } }] },
    ];
    if (args.imageUrl) {
      sections.push({ widgets: [{ image: { imageUrl: args.imageUrl, onClick: { openLink: { url: args.imageUrl } } } }] });
    }
    return post({
      cards: [
        {
          header: {
            title: args.title ?? "",
            subtitle: args.subtitle ?? undefined,
          },
          sections,
        },
      ],
    });
  }

  throw new Error(`Unknown Google Chat tool: ${name}`);
}

async function executeServiceNowTool(name: string, args: Record<string, string>, creds: ServiceNowCredentials): Promise<unknown> {
  const base = creds.instanceUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const snFetch = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ServiceNow ${path} responded with ${res.status} — ${text.slice(0, 300)}`);
    }
    return res.json();
  };

  const isLikeSysId = (id: string) => /^[0-9a-f]{32}$/i.test(id);

  if (name === "servicenow_search_records") {
    const limit = Math.min(parseInt(args.limit ?? "10") || 10, 50);
    const fields = args.fields ? `&sysparm_fields=${encodeURIComponent(args.fields)}` : "";
    const data = await snFetch(
      `/api/now/table/${encodeURIComponent(args.table)}?sysparm_query=${encodeURIComponent(args.query)}&sysparm_limit=${limit}&sysparm_display_value=true${fields}`
    ) as any;
    return { table: args.table, count: data.result?.length ?? 0, records: data.result ?? [] };
  }

  if (name === "servicenow_get_incident") {
    const id = args.identifier;
    const query = isLikeSysId(id) ? `sys_id=${id}` : `number=${id}`;
    const data = await snFetch(
      `/api/now/table/incident?sysparm_query=${query}&sysparm_limit=1&sysparm_display_value=true` +
      `&sysparm_fields=number,sys_id,short_description,description,state,urgency,impact,priority,category,` +
      `assignment_group,assigned_to,caller_id,work_notes,opened_at,resolved_at,close_notes`
    ) as any;
    const record = data.result?.[0];
    if (!record) throw new Error(`Incident not found: ${id}`);
    return record;
  }

  if (name === "servicenow_create_incident") {
    const body: Record<string, unknown> = {
      short_description: args.short_description,
      ...(args.description ? { description: args.description } : {}),
      ...(args.urgency ? { urgency: args.urgency } : {}),
      ...(args.impact ? { impact: args.impact } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.assignment_group ? { assignment_group: args.assignment_group } : {}),
      ...(args.caller_id ? { caller_id: args.caller_id } : {}),
      ...(args.work_notes ? { work_notes: args.work_notes } : {}),
    };
    const data = await snFetch("/api/now/table/incident", { method: "POST", body: JSON.stringify(body) }) as any;
    const rec = data.result;
    return { number: rec.number, sys_id: rec.sys_id, link: `${base}/nav_to.do?uri=incident.do?sys_id=${rec.sys_id}` };
  }

  if (name === "servicenow_update_record") {
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(args.fields); } catch { throw new Error(`fields must be a valid JSON object string`); }
    await snFetch(`/api/now/table/${encodeURIComponent(args.table)}/${args.sys_id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
    return { updated: true, table: args.table, sys_id: args.sys_id, fields_updated: Object.keys(fields) };
  }

  if (name === "servicenow_add_work_note") {
    await snFetch(`/api/now/table/${encodeURIComponent(args.table)}/${args.sys_id}`, {
      method: "PATCH",
      body: JSON.stringify({ work_notes: args.work_note }),
    });
    return { added: true, table: args.table, sys_id: args.sys_id };
  }

  if (name === "servicenow_get_ritm") {
    const id = args.identifier;
    const query = isLikeSysId(id) ? `sys_id=${id}` : `number=${id}`;
    const data = await snFetch(
      `/api/now/table/sc_req_item?sysparm_query=${query}&sysparm_limit=1&sysparm_display_value=true` +
      `&sysparm_fields=number,sys_id,short_description,stage,state,cat_item,request,requested_for,assignment_group,opened_at`
    ) as any;
    const record = data.result?.[0];
    if (!record) throw new Error(`RITM not found: ${id}`);
    const ritmSysId = isLikeSysId(id) ? id : record.sys_id;
    let variables: unknown[] = [];
    try {
      const varData = await snFetch(`/api/now/table/sc_item_option_mtom?sysparm_query=request_item=${ritmSysId}&sysparm_display_value=true&sysparm_fields=sc_item_option`) as any;
      const varSysIds: string[] = (varData.result ?? []).map((r: any) => r.sc_item_option?.value).filter(Boolean);
      if (varSysIds.length > 0) {
        const optData = await snFetch(`/api/now/table/sc_item_option?sysparm_query=sys_id=${varSysIds.join("^ORsys_id=")}&sysparm_display_value=true&sysparm_fields=item_option,value`) as any;
        variables = (optData.result ?? []).map((v: any) => ({ name: v.item_option?.display_value ?? v.item_option?.value, value: v.value }));
      }
    } catch { }
    return { ...record, variables };
  }

  if (name === "servicenow_create_ritm") {
    const catalogSysId = args.catalog_item_sys_id;
    let variables: Record<string, string> = {};
    if (args.variables) {
      try { variables = JSON.parse(args.variables); } catch { throw new Error(`variables must be a valid JSON object string`); }
    }
    const body: Record<string, unknown> = {
      sysparm_quantity: args.quantity ?? "1",
      variables,
      ...(args.requested_for ? { requested_for: args.requested_for } : {}),
    };
    const data = await snFetch(`/api/sn_sc/servicecatalog/items/${encodeURIComponent(catalogSysId)}/order_now`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as any;
    const reqResult = data.result ?? data;
    const reqNumber = reqResult.request_number ?? reqResult.number;
    const reqSysId = reqResult.request_id?.value ?? reqResult.sys_id;
    let ritmNumber: string | undefined;
    let ritmSysId: string | undefined;
    if (reqSysId) {
      try {
        const ritmData = await snFetch(`/api/now/table/sc_req_item?sysparm_query=request=${reqSysId}&sysparm_limit=1&sysparm_fields=number,sys_id`) as any;
        ritmNumber = ritmData.result?.[0]?.number;
        ritmSysId = ritmData.result?.[0]?.sys_id;
      } catch { }
    }
    return {
      request_number: reqNumber,
      request_sys_id: reqSysId,
      ritm_number: ritmNumber,
      ritm_sys_id: ritmSysId,
      link: reqSysId ? `${base}/nav_to.do?uri=sc_request.do?sys_id=${reqSysId}` : undefined,
    };
  }

  if (name === "servicenow_create_change_request") {
    const body: Record<string, unknown> = {
      short_description: args.short_description,
      ...(args.description ? { description: args.description } : {}),
      ...(args.type ? { type: args.type } : {}),
      ...(args.assignment_group ? { assignment_group: args.assignment_group } : {}),
      ...(args.risk ? { risk: args.risk } : {}),
      ...(args.start_date ? { start_date: args.start_date } : {}),
      ...(args.end_date ? { end_date: args.end_date } : {}),
    };
    const data = await snFetch("/api/now/table/change_request", { method: "POST", body: JSON.stringify(body) }) as any;
    const rec = data.result;
    return { number: rec.number, sys_id: rec.sys_id, link: `${base}/nav_to.do?uri=change_request.do?sys_id=${rec.sys_id}` };
  }

  if (name === "servicenow_get_catalog_items") {
    const limit = Math.min(parseInt(args.limit ?? "20") || 20, 50);
    const queryParts = ["active=true"];
    if (args.search) queryParts.push(`nameLIKE${args.search}`);
    if (args.category) queryParts.push(`category.nameLIKE${args.category}`);
    const data = await snFetch(
      `/api/now/table/sc_cat_item?sysparm_query=${encodeURIComponent(queryParts.join("^"))}` +
      `&sysparm_limit=${limit}&sysparm_display_value=true&sysparm_fields=sys_id,name,short_description,category,active`
    ) as any;
    return {
      count: data.result?.length ?? 0,
      items: (data.result ?? []).map((item: any) => ({
        sys_id: item.sys_id,
        name: item.name,
        short_description: item.short_description,
        category: item.category?.display_value ?? item.category,
        active: item.active,
      })),
    };
  }

  throw new Error(`Unknown ServiceNow tool: ${name}`);
}

export async function retrieveRAGFlowContext(
  question: string,
  creds: RAGFlowCredentials,
): Promise<Array<{ content: string; documentName: string; score: number }>> {
  const base = creds.baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" };

  const listRes = await fetch(`${base}/api/v1/datasets?page=1&page_size=50`, { headers });
  if (!listRes.ok) return [];
  const listData = await listRes.json() as any;
  const datasets: string[] = (listData?.data?.docs ?? listData?.data ?? []).map((d: any) => d.id).filter(Boolean);
  if (datasets.length === 0) return [];

  const body = { question, dataset_ids: datasets, top_k: 6 };
  const res = await fetch(`${base}/api/v1/retrieval`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) return [];
  const data = await res.json() as any;
  return extractRAGFlowChunks(data);
}
