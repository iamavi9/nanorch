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

export type CloudCredentials =
  | { provider: "aws"; credentials: AWSCredentials }
  | { provider: "gcp"; credentials: GCPCredentials }
  | { provider: "azure"; credentials: AzureCredentials }
  | { provider: "ragflow"; credentials: RAGFlowCredentials };

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
      const url = `${baseUrl.replace(/\/$/, "")}/api/v1/datasets?page=1&page_size=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`RAGFlow responded with ${res.status}`);
      const data = await res.json() as any;
      const count = data?.data?.total ?? "unknown";
      return { ok: true, detail: `Connected to RAGFlow — ${count} dataset(s) found` };
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
