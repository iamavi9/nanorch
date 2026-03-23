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
    "Execute code in a secure, isolated sandbox and return the output. " +
    "Supports Python, JavaScript, Bash, Ruby, R, Go, and Java. " +
    "Use this to run computations, parse data, generate reports, or demonstrate scripts. " +
    "The sandbox has no network access and no filesystem access beyond /tmp. " +
    "CRITICAL — output rules (scripts do NOT behave like a REPL; bare expressions produce no output): " +
    "Python: always use print() for every value you want to show — e.g. print(result), print(hash_value). A bare variable name on the last line produces NO output. " +
    "JavaScript: always use console.log() — e.g. console.log(result). A bare expression produces NO output. " +
    "Bash: use echo. Ruby: use puts or p. R: use print() or cat(). " +
    "Go requires 'package main' and 'func main()'. " +
    "Java uses single-source-file execution — write a class with a main method (class name need not match filename).",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "Programming language to use",
        enum: ["python", "javascript", "bash", "ruby", "r", "go", "java"],
      },
      code: {
        type: "string",
        description: "The code to execute. Always use explicit print/log statements to produce output — bare expressions at the end of a script are silently discarded.",
      },
    },
    required: ["language", "code"],
  },
};

export const JIRA_TOOLS: ToolDefinition[] = [
  {
    name: "jira_list_projects",
    description: "List all accessible JIRA projects",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "jira_search_issues",
    description: "Search JIRA issues using JQL (JIRA Query Language)",
    parameters: {
      type: "object",
      properties: {
        jql: { type: "string", description: "JQL query string, e.g. 'project = CORE AND status = Open ORDER BY created DESC'" },
        maxResults: { type: "string", description: "Maximum number of results to return (default 20, max 50)" },
      },
      required: ["jql"],
    },
  },
  {
    name: "jira_get_issue",
    description: "Get details of a specific JIRA issue by its key",
    parameters: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "JIRA issue key, e.g. CORE-123" },
      },
      required: ["issueKey"],
    },
  },
  {
    name: "jira_create_issue",
    description: "Create a new JIRA issue",
    parameters: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "JIRA project key (e.g. CORE)" },
        summary: { type: "string", description: "Issue title/summary" },
        issueType: { type: "string", description: "Issue type: Bug, Task, Story, Epic", enum: ["Bug", "Task", "Story", "Epic", "Subtask"] },
        description: { type: "string", description: "Issue description (plain text)" },
        priority: { type: "string", description: "Priority: Highest, High, Medium, Low, Lowest", enum: ["Highest", "High", "Medium", "Low", "Lowest"] },
        assignee: { type: "string", description: "Assignee account ID or email (optional)" },
      },
      required: ["projectKey", "summary", "issueType"],
    },
  },
  {
    name: "jira_update_issue",
    description: "Update fields of an existing JIRA issue",
    parameters: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "JIRA issue key, e.g. CORE-123" },
        summary: { type: "string", description: "New summary (optional)" },
        status: { type: "string", description: "Transition to this status name (optional)" },
        priority: { type: "string", description: "New priority (optional)" },
        assignee: { type: "string", description: "New assignee account ID (optional)" },
      },
      required: ["issueKey"],
    },
  },
  {
    name: "jira_add_comment",
    description: "Add a comment to a JIRA issue",
    parameters: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "JIRA issue key, e.g. CORE-123" },
        comment: { type: "string", description: "Comment text to add" },
      },
      required: ["issueKey", "comment"],
    },
  },
  {
    name: "jira_list_sprints",
    description: "List active and recent sprints for a JIRA board",
    parameters: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "JIRA board ID (numeric)" },
        state: { type: "string", description: "Sprint state filter: active, future, closed", enum: ["active", "future", "closed"] },
      },
      required: ["boardId"],
    },
  },
];

export const GITHUB_TOOLS: ToolDefinition[] = [
  {
    name: "github_list_repos",
    description: "List GitHub repositories for a user or organisation",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub username or organisation (uses default if omitted)" },
        type: { type: "string", description: "Repository type: all, public, private, forks, sources", enum: ["all", "public", "private", "forks", "sources"] },
      },
      required: [],
    },
  },
  {
    name: "github_list_issues",
    description: "List issues in a GitHub repository",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner/org" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "Issue state: open, closed, all", enum: ["open", "closed", "all"] },
        labels: { type: "string", description: "Comma-separated label names to filter by (optional)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_get_issue",
    description: "Get details of a specific GitHub issue",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner/org" },
        repo: { type: "string", description: "Repository name" },
        issueNumber: { type: "string", description: "Issue number" },
      },
      required: ["owner", "repo", "issueNumber"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create a new GitHub issue",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner/org" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body/description (Markdown)" },
        labels: { type: "string", description: "Comma-separated label names (optional)" },
        assignees: { type: "string", description: "Comma-separated GitHub usernames to assign (optional)" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "github_list_pull_requests",
    description: "List pull requests in a GitHub repository",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner/org" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "PR state: open, closed, all", enum: ["open", "closed", "all"] },
        base: { type: "string", description: "Filter by base branch name (optional)" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_create_pull_request",
    description: "Create a new GitHub pull request",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner/org" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR description (Markdown)" },
        head: { type: "string", description: "Branch to merge from (e.g. feature/my-branch)" },
        base: { type: "string", description: "Branch to merge into (e.g. main)" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "github_list_workflow_runs",
    description: "List recent GitHub Actions workflow runs",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner/org" },
        repo: { type: "string", description: "Repository name" },
        status: { type: "string", description: "Filter by status: queued, in_progress, completed, failure, success", enum: ["queued", "in_progress", "completed", "failure", "success"] },
        branch: { type: "string", description: "Filter by branch name (optional)" },
      },
      required: ["owner", "repo"],
    },
  },
];

export const GITLAB_TOOLS: ToolDefinition[] = [
  {
    name: "gitlab_list_projects",
    description: "List accessible GitLab projects",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search term to filter projects by name (optional)" },
        owned: { type: "string", description: "Set to 'true' to return only projects owned by the authenticated user" },
      },
      required: [],
    },
  },
  {
    name: "gitlab_list_issues",
    description: "List issues in a GitLab project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or URL-encoded path (e.g. 123 or mygroup%2Fmyproject)" },
        state: { type: "string", description: "Filter by state: opened, closed, all", enum: ["opened", "closed", "all"] },
        labels: { type: "string", description: "Comma-separated label names to filter by (optional)" },
        assigneeUsername: { type: "string", description: "Filter by assignee username (optional)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "gitlab_get_issue",
    description: "Get details of a specific GitLab issue",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or path" },
        issueIid: { type: "string", description: "Issue internal ID (iid)" },
      },
      required: ["projectId", "issueIid"],
    },
  },
  {
    name: "gitlab_create_issue",
    description: "Create a new GitLab issue",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or path" },
        title: { type: "string", description: "Issue title" },
        description: { type: "string", description: "Issue description (Markdown, optional)" },
        labels: { type: "string", description: "Comma-separated labels (optional)" },
        assigneeUsernames: { type: "string", description: "Comma-separated usernames to assign (optional)" },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "gitlab_list_merge_requests",
    description: "List merge requests in a GitLab project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or path" },
        state: { type: "string", description: "MR state: opened, closed, merged, all", enum: ["opened", "closed", "merged", "all"] },
        targetBranch: { type: "string", description: "Filter by target branch (optional)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "gitlab_create_merge_request",
    description: "Create a new GitLab merge request",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or path" },
        title: { type: "string", description: "MR title" },
        description: { type: "string", description: "MR description (Markdown, optional)" },
        sourceBranch: { type: "string", description: "Branch to merge from" },
        targetBranch: { type: "string", description: "Branch to merge into (e.g. main)" },
      },
      required: ["projectId", "title", "sourceBranch", "targetBranch"],
    },
  },
  {
    name: "gitlab_list_pipelines",
    description: "List recent CI/CD pipelines for a GitLab project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or path" },
        status: { type: "string", description: "Filter by status: running, pending, success, failed, canceled", enum: ["running", "pending", "success", "failed", "canceled"] },
        ref: { type: "string", description: "Filter by branch or tag name (optional)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "gitlab_trigger_pipeline",
    description: "Trigger a new CI/CD pipeline for a GitLab project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GitLab project ID or path" },
        ref: { type: "string", description: "Branch or tag name to run the pipeline on" },
      },
      required: ["projectId", "ref"],
    },
  },
];

export const TEAMS_TOOLS: ToolDefinition[] = [
  {
    name: "teams_send_message",
    description: "Send a plain markdown message to a Microsoft Teams channel via the configured incoming webhook",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text (supports markdown formatting)" },
        color: { type: "string", description: "Hex accent color for the card border, e.g. 0076D7 (blue), FF0000 (red), 00C176 (green)" },
      },
      required: ["text"],
    },
  },
  {
    name: "teams_send_notification",
    description: "Send a structured notification card to Microsoft Teams with a title, body, optional key-value facts, and an optional action button link",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title shown prominently at the top" },
        subtitle: { type: "string", description: "Optional subtitle shown below the title" },
        body: { type: "string", description: "Main body text of the notification (markdown supported)" },
        facts: { type: "string", description: "Optional JSON object of key-value pairs to display as a facts table, e.g. {\"Issue\": \"NAN-3\", \"Priority\": \"High\"}" },
        actionLabel: { type: "string", description: "Label for an optional action button (requires actionUrl)" },
        actionUrl: { type: "string", description: "URL that the action button opens" },
        color: { type: "string", description: "Hex accent color for the card, e.g. 0076D7" },
      },
      required: ["title", "body"],
    },
  },
];

export const SLACK_TOOLS: ToolDefinition[] = [
  {
    name: "slack_send_message",
    description: "Send a plain text or mrkdwn message to a Slack channel via the configured bot token",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID or name (e.g. C012AB3CD or #general). Uses the default channel configured in the integration if omitted." },
        text: { type: "string", description: "Message text (supports Slack mrkdwn formatting: *bold*, _italic_, `code`, >quote)" },
      },
      required: ["text"],
    },
  },
  {
    name: "slack_send_notification",
    description: "Send a structured attachment-based notification to a Slack channel with a title, body, optional key-value fields, and a colour bar",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID or name. Uses default channel if omitted." },
        title: { type: "string", description: "Bold title shown at the top of the notification" },
        body: { type: "string", description: "Main notification body text (mrkdwn supported)" },
        fields: { type: "string", description: "Optional JSON object of key-value pairs shown as fields, e.g. {\"Status\": \"OK\", \"Agent\": \"Heartbeat\"}" },
        color: { type: "string", description: "Attachment colour: good (green), warning (yellow), danger (red), or any CSS hex colour e.g. #0076D7" },
      },
      required: ["title", "body"],
    },
  },
];

export const GOOGLE_CHAT_TOOLS: ToolDefinition[] = [
  {
    name: "google_chat_send_message",
    description: "Send a plain text message to the configured Google Chat space via incoming webhook",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text to send. Supports basic Google Chat formatting (*bold*, _italic_, ~strikethrough~, `code`)." },
      },
      required: ["text"],
    },
  },
  {
    name: "google_chat_send_card",
    description: "Send a formatted card to Google Chat with a title, optional subtitle, and body text",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card header title shown prominently" },
        subtitle: { type: "string", description: "Optional subtitle shown below the title" },
        body: { type: "string", description: "Main card body text" },
        imageUrl: { type: "string", description: "Optional HTTPS image URL to display in the card" },
      },
      required: ["title", "body"],
    },
  },
];

export const SERVICENOW_TOOLS: ToolDefinition[] = [
  {
    name: "servicenow_search_records",
    description: "Search any ServiceNow table using an encoded query string. Returns records with display values.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "ServiceNow table name, e.g. incident, sc_req_item, change_request, cmdb_ci" },
        query: { type: "string", description: "Encoded query string, e.g. active=true^priority=1 or number=INC0012345" },
        limit: { type: "string", description: "Maximum number of records to return (default 10, max 50)" },
        fields: { type: "string", description: "Comma-separated field names to return (optional — returns key fields by default)" },
      },
      required: ["table", "query"],
    },
  },
  {
    name: "servicenow_get_incident",
    description: "Get a ServiceNow incident by its number (INC...) or sys_id. Returns full incident details including description, state, priority, assignment, and work notes.",
    parameters: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Incident number (e.g. INC0012345) or sys_id (32-char hex)" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "servicenow_create_incident",
    description: "Create a new ServiceNow incident. Returns the incident number, sys_id, and link.",
    parameters: {
      type: "object",
      properties: {
        short_description: { type: "string", description: "Brief one-line description of the incident (required)" },
        description: { type: "string", description: "Full description of the issue (optional)" },
        urgency: { type: "string", description: "Urgency: 1 (High), 2 (Medium), 3 (Low)", enum: ["1", "2", "3"] },
        impact: { type: "string", description: "Impact: 1 (High), 2 (Medium), 3 (Low)", enum: ["1", "2", "3"] },
        category: { type: "string", description: "Incident category (e.g. software, hardware, network — optional)" },
        assignment_group: { type: "string", description: "Name or sys_id of the group to assign the incident to (optional)" },
        caller_id: { type: "string", description: "Username or sys_id of the person reporting the incident (optional)" },
        work_notes: { type: "string", description: "Initial work note to add (optional)" },
      },
      required: ["short_description"],
    },
  },
  {
    name: "servicenow_update_record",
    description: "Update fields on any ServiceNow record by table and sys_id. Use this to change state, assignment, resolution notes, etc.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "ServiceNow table name, e.g. incident, sc_req_item, change_request" },
        sys_id: { type: "string", description: "The sys_id of the record to update (32-char hex)" },
        fields: { type: "string", description: "JSON object string of field names and new values, e.g. {\"state\":\"6\",\"close_notes\":\"Resolved via automation\"}" },
      },
      required: ["table", "sys_id", "fields"],
    },
  },
  {
    name: "servicenow_add_work_note",
    description: "Add a work note (internal comment visible to agents only) to any ServiceNow record — incident, RITM, change request, etc.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "ServiceNow table name, e.g. incident, sc_req_item, change_request" },
        sys_id: { type: "string", description: "The sys_id of the record" },
        work_note: { type: "string", description: "The work note text to add" },
      },
      required: ["table", "sys_id", "work_note"],
    },
  },
  {
    name: "servicenow_get_ritm",
    description: "Get a ServiceNow Requested Item (RITM) by its number (RITM...) or sys_id. Returns fulfilment stage, variables (form answers), and parent request details.",
    parameters: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "RITM number (e.g. RITM0012345) or sys_id (32-char hex)" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "servicenow_create_ritm",
    description: "Submit a ServiceNow Service Catalog item order. Creates a Request (REQ) and one or more Requested Items (RITMs) for fulfilment. Returns the REQ number and RITM sys_id.",
    parameters: {
      type: "object",
      properties: {
        catalog_item_sys_id: { type: "string", description: "The sys_id of the catalog item to order. Use servicenow_get_catalog_items to find available items." },
        variables: { type: "string", description: "JSON object string of variable name-value pairs for the catalog item form, e.g. {\"repo\":\"backend-api\",\"role\":\"write\"}" },
        requested_for: { type: "string", description: "Username or sys_id of the person the item is being requested for (optional — defaults to the integration user)" },
        quantity: { type: "string", description: "Number of items to order (default 1)" },
      },
      required: ["catalog_item_sys_id"],
    },
  },
  {
    name: "servicenow_create_change_request",
    description: "Create a ServiceNow change request. Returns the change number and sys_id.",
    parameters: {
      type: "object",
      properties: {
        short_description: { type: "string", description: "Brief description of the change (required)" },
        description: { type: "string", description: "Full description including justification and implementation plan (optional)" },
        type: { type: "string", description: "Change type: standard, normal, emergency", enum: ["standard", "normal", "emergency"] },
        assignment_group: { type: "string", description: "Name or sys_id of the group responsible (optional)" },
        risk: { type: "string", description: "Risk level: 1 (High), 2 (Medium), 3 (Low), 4 (Very Low)", enum: ["1", "2", "3", "4"] },
        start_date: { type: "string", description: "Planned start datetime in ISO 8601 format (optional)" },
        end_date: { type: "string", description: "Planned end datetime in ISO 8601 format (optional)" },
      },
      required: ["short_description"],
    },
  },
  {
    name: "servicenow_get_catalog_items",
    description: "List available ServiceNow Service Catalog items. Use this to find catalog_item_sys_id values for servicenow_create_ritm.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search term to filter catalog items by name (optional)" },
        category: { type: "string", description: "Category name or sys_id to filter by (optional)" },
        limit: { type: "string", description: "Maximum results to return (default 20)" },
      },
      required: [],
    },
  },
];

export const ALL_TOOLS: Record<string, ToolDefinition[]> = {
  aws: AWS_TOOLS,
  gcp: GCP_TOOLS,
  azure: AZURE_TOOLS,
  ragflow: RAGFLOW_TOOLS,
  jira: JIRA_TOOLS,
  github: GITHUB_TOOLS,
  gitlab: GITLAB_TOOLS,
  teams: TEAMS_TOOLS,
  slack: SLACK_TOOLS,
  google_chat: GOOGLE_CHAT_TOOLS,
  servicenow: SERVICENOW_TOOLS,
};

export function getToolsForProvider(cloudProvider: "aws" | "gcp" | "azure" | "ragflow" | "jira" | "github" | "gitlab" | "teams" | "slack" | "google_chat" | "servicenow"): ToolDefinition[] {
  return ALL_TOOLS[cloudProvider] ?? [];
}

export const REQUEST_APPROVAL_TOOL: ToolDefinition = {
  name: "request_approval",
  description:
    "Pause the current task and request human approval before proceeding. " +
    "Use this for irreversible, sensitive, or high-impact actions such as deleting resources, " +
    "sending emails to customers, deploying to production, or spending money. " +
    "After calling this tool, summarize what you requested and wait for human response.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Clear description of what needs approval and why it requires human review",
      },
      action: {
        type: "string",
        description: "The specific action that will be taken upon approval (be precise and concise)",
      },
      impact: {
        type: "string",
        description: "What will happen if approved — describe consequences, scope, and reversibility",
      },
    },
    required: ["message", "action"],
  },
};

export const SPAWN_AGENT_TOOL: ToolDefinition = {
  name: "spawn_agent",
  description:
    "Delegate a specific subtask to a specialist agent and wait for the result. " +
    "Multiple spawn_agent calls within the same response run in parallel automatically. " +
    "Use the agentId from the available agents list provided in your system context.",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "The ID of the target agent to delegate to (from the available agents list)",
      },
      agentName: {
        type: "string",
        description: "The display name of the target agent",
      },
      prompt: {
        type: "string",
        description: "The specific task, question, or instructions to send to this agent",
      },
    },
    required: ["agentId", "prompt"],
  },
};

export function getToolByName(name: string): ToolDefinition | undefined {
  if (name === "code_interpreter") return CODE_INTERPRETER_TOOL;
  if (name === "request_approval") return REQUEST_APPROVAL_TOOL;
  if (name === "spawn_agent") return SPAWN_AGENT_TOOL;
  return [...AWS_TOOLS, ...GCP_TOOLS, ...AZURE_TOOLS, ...RAGFLOW_TOOLS, ...JIRA_TOOLS, ...GITHUB_TOOLS, ...GITLAB_TOOLS, ...TEAMS_TOOLS, ...SLACK_TOOLS, ...GOOGLE_CHAT_TOOLS, ...SERVICENOW_TOOLS].find((t) => t.name === name);
}

export function detectProviderFromToolName(name: string): "aws" | "gcp" | "azure" | "ragflow" | "jira" | "github" | "gitlab" | "teams" | "slack" | "google_chat" | "servicenow" | "sandbox" | "approval" | null {
  if (name === "code_interpreter") return "sandbox";
  if (name === "request_approval") return "approval";
  if (name.startsWith("aws_")) return "aws";
  if (name.startsWith("gcp_")) return "gcp";
  if (name.startsWith("azure_")) return "azure";
  if (name.startsWith("ragflow_")) return "ragflow";
  if (name.startsWith("jira_")) return "jira";
  if (name.startsWith("github_")) return "github";
  if (name.startsWith("gitlab_")) return "gitlab";
  if (name.startsWith("teams_")) return "teams";
  if (name.startsWith("slack_")) return "slack";
  if (name.startsWith("google_chat_")) return "google_chat";
  if (name.startsWith("servicenow_")) return "servicenow";
  return null;
}
