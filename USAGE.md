# NanoOrch — Usage Guide

A step-by-step walkthrough for setting up workspaces, agents, cloud integrations, and chatting with your agents.

---

## Table of Contents

1. [Logging in](#1-logging-in)
2. [Creating a workspace](#2-creating-a-workspace)
3. [Creating an orchestrator](#3-creating-an-orchestrator)
4. [Creating agents](#4-creating-agents)
5. [Chatting with agents](#5-chatting-with-agents)
6. [Running code from chat](#6-running-code-from-chat)
7. [Submitting tasks](#7-submitting-tasks)
8. [Adding integrations](#8-adding-integrations)
9. [Setting up a webhook channel](#9-setting-up-a-webhook-channel)
10. [Adding members](#10-adding-members)
11. [Member experience](#11-member-experience)

---

## 1. Logging in

Go to `http://<your-host>:3000` and log in with your admin credentials.

- Default: `admin` / `admin` (if you didn't set `ADMIN_USERNAME`/`ADMIN_PASSWORD`)
- After login you land on the **Workspaces** dashboard

---

## 2. Creating a workspace

A workspace is an isolated environment for a team or project. Everything — orchestrators, agents, tasks, cloud integrations, members — lives inside a workspace.

1. Click **New Workspace**
2. Enter a name (e.g. `DevOps Team`) and an optional description
3. Click **Create**

The workspace slug is auto-generated from the name and used in member chat URLs (`/chat/:slug`).

---

## 3. Creating an orchestrator

An orchestrator defines which AI provider and model your agents use, plus a shared system prompt for all agents in that orchestrator.

1. Open a workspace → click **Orchestrators** in the sidebar → **New Orchestrator**
2. Fill in:
   - **Name** — e.g. `Main Bot`
   - **Provider** — OpenAI / Anthropic / Gemini / Ollama
   - **Model** — pick from the dropdown (or type freely for Ollama)
   - **Base URL** — Ollama only; e.g. `http://localhost:11434`
   - **System Prompt** — instructions shared by all agents (e.g. `You are a helpful DevOps assistant.`)
   - **Temperature** — controls creativity (0 = deterministic, 100 = very creative)
   - **Max Tokens** — upper limit per response
3. Click **Create**

You can create multiple orchestrators per workspace — useful for separating a "fast" GPT-4o-mini bot from a "powerful" Claude Opus one.

---

## 4. Creating agents

Agents live inside an orchestrator and each has its own name, persona instructions, and tool access.

1. Open an orchestrator → **Agents** → **New Agent**
2. Fill in:
   - **Name** — shown in `@mention` autocomplete (e.g. `infra-bot`)
   - **Instructions** — agent-specific persona on top of the orchestrator system prompt (e.g. `Focus only on AWS infrastructure questions.`)
   - **Temperature / Max Tokens** — override the orchestrator defaults if needed
   - **Enable Memory** — if on, the agent remembers facts from past conversations
   - **Tools** — tick which cloud tools this agent can call (only shown if cloud integrations exist in this workspace)
3. Click **Create**

> **Tip:** Create specialist agents per domain — one for AWS, one for GCP, one for docs search — and let users `@mention` the right one.

---

## 5. Chatting with agents

The chat UI is the main way to interact with agents in real time.

1. Open a workspace → **Chat** in the sidebar
2. Type `@` to trigger agent autocomplete
   - Use **↑ / ↓** arrow keys to highlight an agent
   - Press **Enter** or **Tab** to insert the highlighted agent
   - Press **Escape** to dismiss the dropdown
   - Or just click the agent name
3. Continue your message: `@infra-bot list my S3 buckets`
4. Hit **Enter** — the response streams in token by token

### Message types

| What you type | What happens |
|---|---|
| `@agent explain what Lambda is` | Conversational — answered in-process, instant |
| `@agent calculate compound interest on $10k at 5% for 20 years` | Code execution — agent writes and runs Python/JS in an isolated sandbox, returns the result inline |
| `@agent create an S3 bucket called my-bucket` | Action — a confirmation card appears first |

### Action confirmation

When the agent detects a **write operation** (create / modify / delete), it pauses and shows a confirmation card:

> **Pending action**: Create S3 bucket `my-bucket` in `us-east-1`
> [ Approve ] [ Cancel ]

- **Approve** → a task is created and runs in an isolated container (in production with Docker) or in-process (dev)
- **Cancel** → nothing happens

### RAGFlow sources

If a RAGFlow integration is active and the agent queries it, cited document chunks appear in a collapsible **Sources** panel below the agent reply.

---

## 6. Running code from chat

Agents can write and execute Python or JavaScript **inline** — the code runs in a locked-down sandbox on the server and the result comes back in the same message thread, no setup required on your end.

### What it looks like

1. Type a prompt that requires computation:
   ```
   @data-bot calculate the compound interest on $10,000 at 5% per year over 20 years
   ```
2. The chat shows a pulsing indicator while the code runs:
   ```
   ⚙ running python in sandbox…
   ```
3. The result streams back as soon as it's ready:
   ```
   After 20 years at 5% annual compound interest, $10,000 grows to $26,532.98.
   ```

### Example prompts

These all trigger code execution automatically — the agent decides when to write and run code:

| Prompt | What the agent does |
|---|---|
| `@agent what is the SHA-256 hash of "hello world"?` | Writes Python using `hashlib`, runs it, returns the hash |
| `@agent generate a Fibonacci sequence up to 1000` | Writes a loop, returns the list |
| `@agent how many days until December 31, 2026?` | Uses `datetime`, computes the delta |
| `@agent parse this JSON and count items with status "active": [{"status":"active"},...]` | Parses with `json`, filters, counts |
| `@agent convert this CSV to a sorted list: name,age\nAlice,30\nBob,25` | Processes with the `csv` module |
| `@agent is 104729 a prime number?` | Runs a primality check |

### What the sandbox can and cannot do

| Can do | Cannot do |
|---|---|
| Full Python 3.12 standard library | Make network requests (no internet) |
| Full Node.js 20 built-ins | Write files that persist after the run |
| Math, string, datetime, crypto, regex, JSON, CSV | Access the host machine or other containers |
| Run for up to 15 seconds | Use more than 256 MB of RAM |

### No setup needed from you

As a user, there is nothing to configure. The sandbox image is built once by whoever runs the server (`docker build -t nanoorch-sandbox:latest ./agent/sandbox`), and NanoOrch handles everything else automatically.

If an admin has not built the sandbox image yet, the agent will fall back to a conversational answer and explain that it cannot run code in this environment.

---

## 7. Submitting tasks

Tasks are discrete jobs that run through the full executor pipeline (tool-calling loop, Docker isolation in production).

### Via the UI

1. Open an orchestrator → **Tasks** → **New Task**
2. Enter a prompt and optionally pick an agent
3. Click **Submit**
4. Click the task row to open the **Task Detail** page — logs stream in real time via SSE

### Via webhook

Each channel has a unique webhook URL. Send a POST:

```bash
curl -X POST https://<host>/api/channels/<channel-id>/webhook \
  -H "Content-Type: application/json" \
  -d '{"input": "list all EC2 instances in us-east-1"}'
```

### Via API key channel

Create a channel with type **API Key**, copy the key, then:

```bash
curl -X POST https://<host>/api/channels/<channel-id>/webhook \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"input": "summarise last week CloudWatch errors"}'
```

### Monitoring task logs

- **UI**: Task Detail page — live log stream with color-coded levels (`INFO`, `WARN`, `ERROR`, `TOOL`)
- **WebSocket**: Connect to `ws://<host>/ws` with an active session cookie to receive all log events in real time
- **SSE**: `GET /api/tasks/:id/stream` streams logs for a single task

---

## 8. Adding integrations

Cloud integrations let agents call real AWS, GCP, Azure, and RAGFlow APIs — or automatically pull in knowledge from RAGFlow before every response.

1. Open a workspace → **Integrations** → **Add Integration**
2. Select a provider tab and enter credentials:

| Provider | Credentials needed |
|---|---|
| **AWS** | Access Key ID, Secret Access Key, Region |
| **GCP** | Service Account JSON (paste the full key file contents) |
| **Azure** | Client ID, Client Secret, Tenant ID, Subscription ID |
| **RAGFlow** | Base URL (e.g. `http://ragflow:9380`), API Key |

3. Choose an **Integration Mode** (see below)
4. Click **Save Integration** — credentials are AES-256-GCM encrypted before hitting the database
5. Click **Test** to verify the credentials work (makes a lightweight read-only API call)
6. For Tool-mode integrations: go to the agent's settings → **Tools** — tick the tools you want this agent to use

### Integration Modes

| Mode | What it does |
|------|-------------|
| **Tool** | The agent explicitly decides to call this integration during action tasks. Requires the user to approve the action first. Best for AWS, GCP, Azure. |
| **Context** | Knowledge is retrieved automatically and added to the agent's context before every reply — no approval step, no explicit tool call. Best for RAGFlow knowledge bases. |

**Default modes:** AWS, GCP, and Azure default to **Tool**. RAGFlow defaults to **Context**.

When a RAGFlow context integration is active, the agent response includes a collapsible **Sources** panel showing the document chunks that were retrieved.

### Editing an integration

Click the **Edit** button (pencil icon) on any integration card to:
- Change the integration name
- Switch the mode between Tool and Context
- Rotate credentials — fill in the credential fields to replace them, or leave them blank to keep the existing encrypted values unchanged

### Available tools (Tool mode)

| Provider | Tools |
|---|---|
| AWS | `aws_list_s3_buckets`, `aws_list_s3_objects`, `aws_list_ec2_instances`, `aws_list_lambda_functions`, `aws_get_cloudwatch_logs` |
| GCP | `gcp_list_storage_buckets`, `gcp_list_compute_instances`, `gcp_list_cloud_functions` |
| Azure | `azure_list_resource_groups`, `azure_list_virtual_machines`, `azure_list_storage_accounts` |
| RAGFlow | `ragflow_list_datasets`, `ragflow_query_dataset`, `ragflow_query_multiple_datasets` |

> **Security:** Credentials never enter the agent container — all tool calls execute server-side. Raw credentials are never logged.

---

## 9. Setting up a webhook channel

Channels are how external systems push tasks into NanoOrch.

1. Open an orchestrator → **Channels** → **New Channel**
2. Choose type:
   - **Webhook** — no auth, anyone with the URL can submit tasks (use only on private networks)
   - **API Key** — requires `X-Api-Key` header
3. Copy the webhook URL shown after creation
4. Point your external system (CI/CD pipeline, Slack bot, cron job, etc.) at that URL

---

## 10. Adding members

Members are non-admin users who only see the chat interface for their assigned workspaces.

1. Open a workspace → **Members** → **Add Member**
2. Fill in:
   - **Username** — login name
   - **Display Name** — shown in the UI
   - **Password** — they can be asked to change it on first login
   - **Role** — `member` (chat only) or `admin` (full access)
3. Click **Create** — this creates the user account and adds them to the workspace in one step

To add an existing user to another workspace: **Add Member** → switch to the **Existing User** tab → search by username.

To remove a member: click the trash icon next to their name in the members list.

---

## 11. Member experience

When a `member` logs in they see a clean interface with no admin UI:

- `/member` — list of workspaces they belong to
- `/chat/:slug` — the chat page for that workspace

They can `@mention` any agent in their assigned workspace and chat normally. They cannot see orchestrator settings, task logs, cloud credentials, or other workspaces.

### Sharing the chat link with a member

Give them:
```
http://<your-host>:3000/login
```
After login they are automatically redirected to `/member`.

Or link them directly to the workspace chat:
```
http://<your-host>:3000/chat/<workspace-slug>
```

---

## Quick-start checklist

- [ ] Log in as admin
- [ ] Create a workspace
- [ ] Create an orchestrator (pick provider + model)
- [ ] Create at least one agent
- [ ] (Optional) Add an integration — pick Tool mode for AWS/GCP/Azure, or Context mode for RAGFlow
- [ ] Open Chat → type `@your-agent hello` → confirm it responds
- [ ] Try a code execution prompt: `@your-agent is 104729 a prime number?`
- [ ] (Optional) Create member accounts and share the chat link
