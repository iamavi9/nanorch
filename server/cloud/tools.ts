export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export const AWS_TOOLS: ToolDefinition[] = [
  {
    name: "aws_list_s3_buckets",
    description: "List all S3 buckets in the AWS account",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "aws_list_s3_objects",
    description: "List objects in an S3 bucket",
    parameters: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "S3 bucket name" },
        prefix: { type: "string", description: "Key prefix filter (optional)" },
      },
      required: ["bucket"],
    },
  },
  {
    name: "aws_list_ec2_instances",
    description: "List EC2 instances, optionally filtered by region",
    parameters: {
      type: "object",
      properties: {
        region: { type: "string", description: "AWS region (e.g. us-east-1)" },
        state: { type: "string", description: "Filter by state: running, stopped, terminated", enum: ["running", "stopped", "terminated", "all"] },
      },
      required: [],
    },
  },
  {
    name: "aws_list_lambda_functions",
    description: "List Lambda functions in the AWS account",
    parameters: {
      type: "object",
      properties: {
        region: { type: "string", description: "AWS region (e.g. us-east-1)" },
      },
      required: [],
    },
  },
  {
    name: "aws_get_cloudwatch_logs",
    description: "Get recent CloudWatch log events from a log group",
    parameters: {
      type: "object",
      properties: {
        logGroupName: { type: "string", description: "CloudWatch log group name" },
        region: { type: "string", description: "AWS region" },
        limit: { type: "string", description: "Maximum number of log events to return (default 50)" },
      },
      required: ["logGroupName"],
    },
  },
];

export const GCP_TOOLS: ToolDefinition[] = [
  {
    name: "gcp_list_storage_buckets",
    description: "List all Google Cloud Storage buckets in the project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GCP project ID (uses service account project if omitted)" },
      },
      required: [],
    },
  },
  {
    name: "gcp_list_compute_instances",
    description: "List Google Compute Engine VM instances",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GCP project ID" },
        zone: { type: "string", description: "GCP zone (e.g. us-central1-a). Use '-' for all zones." },
      },
      required: [],
    },
  },
  {
    name: "gcp_list_cloud_functions",
    description: "List Google Cloud Functions in a project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GCP project ID" },
        region: { type: "string", description: "GCP region (e.g. us-central1). Use '-' for all regions." },
      },
      required: [],
    },
  },
];

export const AZURE_TOOLS: ToolDefinition[] = [
  {
    name: "azure_list_resource_groups",
    description: "List all Azure resource groups in the subscription",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "azure_list_virtual_machines",
    description: "List Azure virtual machines, optionally filtered by resource group",
    parameters: {
      type: "object",
      properties: {
        resourceGroup: { type: "string", description: "Resource group name (optional, lists all if omitted)" },
      },
      required: [],
    },
  },
  {
    name: "azure_list_storage_accounts",
    description: "List Azure storage accounts in the subscription",
    parameters: {
      type: "object",
      properties: {
        resourceGroup: { type: "string", description: "Resource group name (optional)" },
      },
      required: [],
    },
  },
];

export const RAGFLOW_TOOLS: ToolDefinition[] = [
  {
    name: "ragflow_list_datasets",
    description: "List all available RAGFlow knowledge base datasets",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "ragflow_query_dataset",
    description: "Query a RAGFlow knowledge base dataset with a natural language question and retrieve relevant chunks",
    parameters: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "ID of the RAGFlow dataset to query" },
        question: { type: "string", description: "The natural language question to search for" },
        top_k: { type: "string", description: "Number of chunks to retrieve (default 5)" },
      },
      required: ["dataset_id", "question"],
    },
  },
  {
    name: "ragflow_query_multiple_datasets",
    description: "Query multiple RAGFlow datasets at once with a natural language question",
    parameters: {
      type: "object",
      properties: {
        dataset_ids: { type: "string", description: "Comma-separated list of dataset IDs to search across" },
        question: { type: "string", description: "The natural language question to search for" },
        top_k: { type: "string", description: "Number of chunks to retrieve per dataset (default 5)" },
      },
      required: ["dataset_ids", "question"],
    },
  },
];

export const CODE_INTERPRETER_TOOL: ToolDefinition = {
  name: "code_interpreter",
  description:
    "Execute Python or JavaScript code in a secure, isolated sandbox and return the output. " +
    "Use this to run computations, parse data, generate reports, or demonstrate scripts. " +
    "The sandbox has no network access and no filesystem access beyond /tmp.",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "Programming language to use",
        enum: ["python", "javascript"],
      },
      code: {
        type: "string",
        description: "The code to execute. Print results to stdout.",
      },
    },
    required: ["language", "code"],
  },
};

export const ALL_TOOLS: Record<string, ToolDefinition[]> = {
  aws: AWS_TOOLS,
  gcp: GCP_TOOLS,
  azure: AZURE_TOOLS,
  ragflow: RAGFLOW_TOOLS,
};

export function getToolsForProvider(cloudProvider: "aws" | "gcp" | "azure" | "ragflow"): ToolDefinition[] {
  return ALL_TOOLS[cloudProvider] ?? [];
}

export function getToolByName(name: string): ToolDefinition | undefined {
  if (name === "code_interpreter") return CODE_INTERPRETER_TOOL;
  return [...AWS_TOOLS, ...GCP_TOOLS, ...AZURE_TOOLS, ...RAGFLOW_TOOLS].find((t) => t.name === name);
}

export function detectProviderFromToolName(name: string): "aws" | "gcp" | "azure" | "ragflow" | "sandbox" | null {
  if (name === "code_interpreter") return "sandbox";
  if (name.startsWith("aws_")) return "aws";
  if (name.startsWith("gcp_")) return "gcp";
  if (name.startsWith("azure_")) return "azure";
  if (name.startsWith("ragflow_")) return "ragflow";
  return null;
}
