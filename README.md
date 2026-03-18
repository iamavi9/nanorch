# NanoOrch — AI Agent Orchestrator Platform

A self-hosted, multi-tenant platform for orchestrating AI agents across OpenAI, Anthropic, Gemini, and **on-prem Ollama** — with 3-tier role-based access control, per-workspace resource limits, Docker-isolated task execution, real-time monitoring, approval gates, pipeline/DAG chaining, observability dashboards, scheduled jobs, **two-way Slack/Teams messaging** (inbound messages routed to agents, replies posted back to the thread), outbound notifications, cloud integrations (AWS/GCP/Azure), DevTools integrations (Jira/GitHub/GitLab), RAGFlow knowledge base support, and a chat UI with `@agent` mentions.

---

## Features

- **Auth & 3-tier RBAC** — session-based login; global admin, workspace admin, and member roles with distinct access levels
- **Multi-tenant workspaces** — isolated environments per team or project
- **Workspace resource limits** — global admins can cap how many orchestrators, agents, channels, and scheduled jobs each workspace may create, and restrict which AI providers and integration types are allowed
- **Member management** — admins create user accounts and assign them to workspaces with a role (admin or member)
- **Multiple orchestrators** — each workspace can have multiple orchestrators with its own AI provider, model, and system prompt
- **Agent management** — create agents per orchestrator with individual instructions, temperature, memory, and tool access
- **Task queue** — submit tasks via UI, webhook endpoint, API key channel, or scheduled job; real-time SSE log streaming
- **Approval gates** — agents pause mid-task and require human sign-off before executing high-impact write operations; pending approvals appear in a dedicated sidebar section with live badge counts
- **Pipeline / DAG chaining** — sequential multi-step pipelines where each step's output is passed as context to the next agent; supports cron scheduling and manual triggers with per-run step history
- **Observability** — token usage and cost dashboard across all 4 providers; daily usage charts, per-agent breakdown, provider/model cost summaries
- **Scheduled jobs** — cron-based agent automation with timezone support, preset schedules, manual trigger, and enable/disable toggle
- **Two-way comms** — enable a workspace as a *comms workspace* to add Slack and Microsoft Teams inbound channels; messages mention the bot or send a direct message → the prompt is routed to an agent → the agent's reply is posted back in the same Slack thread or Teams conversation
- **Outbound notifications** — send task completion/failure alerts to Slack, Teams, Google Chat, or any generic webhook; delivery history per channel
- **AI provider switcher** — OpenAI, Anthropic, Gemini, and Ollama (on-prem); swap per orchestrator
- **Docker-isolated execution** — action tasks run inside ephemeral containers; conversational tasks stay in-process
- **Code execution** — agents write and run Python/JavaScript directly from chat inside a gVisor (`runsc`) sandbox container; fully network-isolated, read-only filesystem, memory/CPU capped
- **Cloud integrations** — AWS, GCP, Azure with AES-256-GCM encrypted credentials and agentic tool calling
- **DevTools integrations** — Jira (7 tools: search/create/update issues, sprints, comments), GitHub (7 tools: repos, issues, PRs, Actions), GitLab (8 tools: issues, MRs, pipelines, triggers)
- **RAGFlow integration** — query knowledge bases as a tool, or auto-inject context before every AI response (Context mode)
- **Intent classification** — LLM-based classifier routes each message to action / code execution / conversational path automatically
- **Chat UI** — per-workspace chat with `@agent` mention autocomplete (keyboard ↑↓ navigation, Enter/Tab to select) and live streaming responses
- **Member chat interface** — clean chat page at `/chat/:slug` for end-users (no admin UI visible)

---

## Screenshots

### Login

![Login](./docs/screenshots/login.png)

*Session-based login page — username and password. First-time default credentials are `admin` / `admin` (overridable with `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars).*

---

### Workspaces

![Workspaces list](./docs/screenshots/workspaces.png)

*Multi-tenant workspace list — Comms badge marks workspaces enabled for two-way Slack/Teams inbound; per-workspace admin actions (edit, limits, delete) via hover.*

---

### Chat Interface

![Chat UI](./docs/screenshots/chat.png)

*Per-workspace chat with `@agent` mention autocomplete (keyboard navigation), live streaming responses, and inline code execution output (Python and Node.js). Conversation history in the left sidebar.*

---

### Code Sandbox Execution

![Code sandbox](./docs/screenshots/executor.png)

*`</> running python in sandbox…` indicator streams in the chat while the agent executes code inside the gVisor-isolated container.*

---

### Task Queue

![Task queue](./docs/screenshots/tasks.png)

*Task queue showing summary counters (Pending / Running / Completed / Failed) and a scrollable task list with status badges, agent name, and relative timestamp.*

---

### Approval Gates

![Approval gates](./docs/screenshots/approvals.png)

*Approval gate — the agent pauses with a full description of the proposed action, a **Predicted Operations** panel showing each tool call and a `read-only` or `write` impact badge, and one-click **Approve & Run** / **Cancel** controls.*

---

### Pipeline / DAG Chaining

![Pipelines](./docs/screenshots/pipelines.png)

*Pipeline list with run history — each run shows status, trigger (Manual / Scheduled), and timestamp. Expand to see per-step output.*

---

### Observability Dashboard

![Observability](./docs/screenshots/observability.png)

*Token usage and cost analytics — four summary cards (Total Tokens, Estimated Cost, Agent Calls, Active Agents), a daily input/output token chart over 30 days, and per-agent and provider breakdowns.*

---

### Two-way Comms — Slack & Teams Inbound

![Two-way comms](./docs/screenshots/comms.png)

*Comms workspace — Slack inbound channel with **Two-way** and **Active** badges, Events Endpoint URL for Slack App Event Subscriptions, and one-click copy button.*

---

### Cloud & DevTools Integrations

![Integrations](./docs/screenshots/integrations.png)

*Integrations page — grouped by CLOUD, DEVTOOLS, and KNOWLEDGE; each card shows provider, last-used timestamp, integration mode badge (Tool / Context), and Test / Edit / Disable / Delete controls.*

---

### Agent Tool Selection

![Tool selection](./docs/screenshots/tools.png)

*Agent tool configuration panel — tools grouped by integration, individually toggled via checkboxes. AWS tools and all 7 Jira tools shown.*

---

### Scheduled Jobs

![Scheduled jobs](./docs/screenshots/scheduled.png)

*Scheduled Jobs — cron expression, timezone (IANA), next-run and last-run timestamps, **Active** badge, and per-job controls: Run Now, Edit, Pause, Delete.*

---

### RAGFlow Knowledge Base Chat

![RAGFlow chat](./docs/screenshots/ragflow-chat.png)

*Agent answering a question from the connected RAGFlow knowledge base. Source count badge (e.g. "26 sources") appears below the reply.*

---

### RAGFlow Source Citations

![RAGFlow sources](./docs/screenshots/ragflow-chat-sources.png)

*Expanded sources panel — each source document listed with a title and excerpt so users can verify the information and navigate to the original document.*

---

## Deploying on EC2

### 1. Launch and connect to your instance

Recommended: **Ubuntu 24.04 LTS**, `t3.small` or larger.

In your EC2 security group, open these inbound ports:

| Port | Source | Purpose |
|------|--------|---------|
| 22 | Your IP | SSH |
| 3000 | 0.0.0.0/0 | NanoOrch web UI (or lock to your IP) |
| 80/443 | 0.0.0.0/0 | Optional — if you put Nginx in front |

```bash
ssh -i your-key.pem ubuntu@<EC2-PUBLIC-IP>
```

---

### 2. Install Docker and gVisor

```bash
# Update and install
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow current user to run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

Verify:
```bash
docker --version        # Docker version 26+
docker compose version  # Docker Compose version 2+
```

**Install gVisor** (required for the code execution sandbox):

```bash
sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates gnupg

curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] \
  https://storage.googleapis.com/gvisor/releases release main" | \
  sudo tee /etc/apt/sources.list.d/gvisor.list

sudo apt-get update && sudo apt-get install -y runsc

# Register runsc as a Docker runtime
sudo runsc install
sudo systemctl restart docker
```

Verify gVisor is registered:
```bash
docker info | grep -A 3 "Runtimes"
# Should show: Runtimes: runc runsc
```

> **gVisor is optional.** If you skip it, set `SANDBOX_RUNTIME=runc` in `.env` to use standard Docker isolation for the code sandbox. The sandbox will still be network-isolated and memory-capped, just without the kernel-level syscall interception.

---

### 3. Clone the repo

```bash
git clone https://github.com/your-org/nanoorch.git
cd nanoorch
```

---

### 4. Configure environment

**Standard setup (secrets in `.env`):**

```bash
cp .env.example .env
nano .env
```

Set these values at minimum:

```env
POSTGRES_PASSWORD=a-strong-db-password
SESSION_SECRET=a-long-random-string-at-least-32-chars
ADMIN_USERNAME=admin
ADMIN_PASSWORD=a-strong-admin-password

# Generate encryption key
ENCRYPTION_KEY=   # run: openssl rand -hex 32

# At least one AI provider key
AI_INTEGRATIONS_OPENAI_API_KEY=sk-...
```

Generate the encryption key in one step:
```bash
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
```

> **Hardened deployment (recommended for production):** Use Docker secrets instead of plain `.env` so that sensitive values **never appear in `docker inspect Env`** output. Run the interactive setup helper and use the secrets-specific compose file:
>
> ```bash
> ./secrets/create-secrets.sh        # generates random keys + prompts for passwords
> docker compose -f docker-compose.secrets.yml up -d
> ```
>
> The app reads credentials via the `_FILE` pattern (`SESSION_SECRET_FILE`, `ADMIN_PASSWORD_FILE`, etc.) — each variable points to a Docker-mounted file at `/run/secrets/<name>` instead of holding the raw value. See [`secrets/README.md`](./secrets/README.md) for the full setup guide.

---

### 5. Build the agent images

**Action task agent** — used for isolated cloud/DevTools action tasks:
```bash
docker build -t nanoorch-agent:latest ./agent
```

**Code sandbox** — used for arbitrary code execution (Python/JavaScript) with gVisor:
```bash
docker build -t nanoorch-sandbox:latest ./agent/sandbox
```

> **gVisor required:** The code sandbox runs with `--runtime=runsc`. Install gVisor on the EC2 instance before using code execution. Set `SANDBOX_RUNTIME=runc` in `.env` to skip gVisor and use standard Docker isolation instead (less secure but functional).

---

### 6. Start everything

**Standard (`.env` file):**
```bash
docker compose up -d
```

**Hardened (Docker secrets):**
```bash
docker compose -f docker-compose.secrets.yml up -d
```

Database migrations run automatically on first boot. Check the logs:

```bash
docker compose logs -f app
# or: docker compose -f docker-compose.secrets.yml logs -f app
```

Look for:
```
[db] Database migrations applied
[express] serving on port 3000
```

---

### 7. Open the app

```
http://<EC2-PUBLIC-IP>:3000
```

Log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set in `.env`.

> If you can't connect: verify your EC2 security group allows inbound TCP on port 3000.

---

### Optional: Nginx reverse proxy (recommended for production)

Put Nginx in front to serve on port 80/443 and handle SSL:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/nanoorch`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nanoorch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Free SSL certificate
sudo certbot --nginx -d your-domain.com
```

---

### Updates

```bash
git pull
docker compose build app
docker compose up -d
```

Migrations run automatically on restart.

---

## Auth & Access Control

### 3-tier role model

NanoOrch uses three levels of access:

| Role | Who | Access |
|------|-----|--------|
| **Global admin** | Set via `ADMIN_USERNAME`/`ADMIN_PASSWORD` or by assigning `admin` role to a user | Full platform access: all workspaces, create/delete workspaces, configure workspace limits, manage all members |
| **Workspace admin** | Workspace member with `admin` role in that workspace | Full access within their assigned workspace(s): orchestrators, agents, tasks, integrations, channels, scheduled jobs, pipelines, approvals, members |
| **Member** | Workspace member with `member` role | Chat-only access at `/chat/:slug` — can talk to agents but cannot see admin UI |

### Default global admin

On first boot, if no admin exists, one is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in your `.env`. This only runs once — changing the env var later won't change an existing account.

### Adding members and workspace admins

1. Log in as a global admin → open a workspace → **Members** in sidebar
2. Click **Add Member** — set username, display name, password, and role:
   - `admin` — becomes a workspace admin for that workspace (can manage orchestrators, agents, etc. within it)
   - `member` — gets chat-only access
3. The user logs in at `/login` and is routed based on their role:
   - Global admins → `/workspaces`
   - Workspace admins → `/workspaces` (scoped to their assigned workspaces)
   - Members → `/member` (chat-only workspace list)

### Workspace resource limits

Global admins can restrict how much each workspace can use. On the **Workspaces** page, hover over a workspace card and click the ⚙ gear icon to open the **Workspace Limits** dialog.

**Resource Quotas tab** — set optional upper bounds (leave blank for unlimited):

| Field | What it caps |
|-------|-------------|
| Max orchestrators | Number of orchestrators in the workspace |
| Max agents | Total agents across all orchestrators |
| Max channels | Total channels across all orchestrators |
| Max scheduled jobs | Number of scheduled jobs in the workspace |

**Allowed Providers tab** — optionally restrict which providers can be used:

| Group | What it restricts |
|-------|------------------|
| AI Providers | Which of openai / anthropic / gemini / ollama can be selected when creating an orchestrator |
| Cloud Integrations | Which of aws / gcp / azure / jira / github / gitlab / ragflow / teams can be added as integrations |
| Channel Types | Which outbound channel types (slack / teams / google_chat / generic_webhook) can be created |

When a limit is hit the API returns `409 Quota exceeded`; when a disallowed provider is used it returns `403 Forbidden`.

---

## How Docker task isolation works

When a user sends a message like `@agent list my Jira issues`, the flow:

1. Intent is classified — detected as `"action"` (an external system operation)
2. A task is created in the queue
3. In Docker Compose (where `DOCKER_SOCKET` is set), the task executor spawns:
   ```
   docker run --rm --memory 512m --cpus 0.5 nanoorch-agent:latest
   ```
4. The container runs AI inference with the tool definitions. If the AI calls a tool (e.g. `jira_search_issues`), the server executes it in-process (credentials never enter the container), then feeds the result back to the next inference round
5. The container exits and is removed automatically
6. On completion, any outbound channels subscribed to `task.completed` are notified

Conversational messages run in-process with no container overhead.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  /login   /workspaces/*   /member   /chat/:slug                  │
│  React + Vite + TanStack Query + Wouter                          │
└────────────────────────┬─────────────────────────────────────────┘
                         │ HTTP + WebSocket
┌────────────────────────▼─────────────────────────────────────────┐
│  Express Server (:3000)                                          │
│                                                                  │
│  3-tier Auth         REST API          Task Engine               │
│  requireAuth /       /api/auth/*       Queue Worker              │
│  requireAdmin /      /api/workspaces/* runAgent()                │
│  requireWorkspace    /api/members/*    Tool Calling Loop         │
│  Admin               /api/integrations Scheduler (node-cron)     │
│                      /api/channels/*   Notifier (outbound)       │
│                      /api/pipelines/*  Approval Gates            │
│                      /api/approvals/*  SSE Stream                │
└───────┬─────────────────────┬────────────────────┬──────────────┘
        │                     │                    │
        ▼                     ▼                    ▼
  PostgreSQL          AI Providers          Integrations
  (Drizzle ORM)       OpenAI                AWS / GCP / Azure
  users               Anthropic             Jira / GitHub / GitLab
  workspaces          Gemini                RAGFlow / Teams
  workspace_config    Ollama (on-prem)
  tasks                                     Outbound Channels
  integrations                              Slack / Teams
  scheduled_jobs                            Google Chat / Webhook
  pipelines / runs
  approval_requests
  channel_deliveries
        │
        ▼
  Docker Socket (/var/run/docker.sock)
        │
        ▼  (action tasks only)
  docker run --rm nanoorch-agent:latest
  Ephemeral container per AI inference round
  Task token (not real AI keys) passed to container
  Inference proxy (/internal/proxy) injects real keys server-side
  Integration credentials stay on server

  Security layers (all containers):
    --cap-drop ALL + --security-opt no-new-privileges (unconditional)
    --runtime runsc  (gVisor, optional via AGENT_RUNTIME / SANDBOX_RUNTIME)
    --security-opt seccomp=<profile>  (optional via SECCOMP_PROFILE)
```

---

## Security Hardening

NanoOrch is designed for hardened production deployments. The security model has three independent layers that can each be enabled separately.

### Layer 1 — Docker secrets (`_FILE` pattern)

By default, secrets like `SESSION_SECRET` and `ADMIN_PASSWORD` are passed as plain environment variables — visible in `docker inspect Env`. For production, use Docker secrets instead:

```bash
./secrets/create-secrets.sh           # interactive setup — generates random keys
docker compose -f docker-compose.secrets.yml up -d
```

Each secret is stored as a one-line file on the host (e.g. `secrets/session_secret.txt`). Docker mounts it read-only at `/run/secrets/<name>` inside the container. The app reads the value via the `_FILE` pattern — `SESSION_SECRET_FILE=/run/secrets/session_secret` — so `docker inspect` only shows the file path, never the real value.

**Variables with `_FILE` support:** `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `ENCRYPTION_KEY`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_GEMINI_API_KEY`.

See [`secrets/README.md`](./secrets/README.md) for setup details and rotation guidance.

### Layer 2 — Container isolation (capabilities + seccomp + gVisor)

Every agent task container and code-sandbox container runs with:

| Flag | What it does |
|------|-------------|
| `--cap-drop ALL` | Drops all Linux capabilities (unconditional — always applied) |
| `--security-opt no-new-privileges` | Prevents privilege escalation via setuid binaries (unconditional) |
| `--security-opt seccomp=<profile>` | Restricts allowed syscalls to ~50 (set `SECCOMP_PROFILE` to enable) |
| `--runtime runsc` | gVisor user-space kernel — syscalls hit a synthetic kernel, not the host (set `SANDBOX_RUNTIME=runsc` / `AGENT_RUNTIME=runsc`) |

**Seccomp profile:** `agent/seccomp/nanoorch.json` allows only the syscalls needed for HTTP calls and JSON parsing, blocking `ptrace`, `mount`, `clone`, etc. Copy it to a stable host path and set `SECCOMP_PROFILE`:

```bash
sudo mkdir -p /etc/nanoorch/seccomp
sudo cp agent/seccomp/nanoorch.json /etc/nanoorch/seccomp/
# In .env:
SECCOMP_PROFILE=/etc/nanoorch/seccomp/nanoorch.json
```

**gVisor** provides kernel-level isolation: even if a container escapes the seccomp filter, it hits gVisor's Go-based synthetic kernel rather than the host kernel. Install `runsc` and set `SANDBOX_RUNTIME=runsc` (for code execution) and/or `AGENT_RUNTIME=runsc` (for action-task agent containers).

### Layer 3 — Inference proxy (AI keys never in containers)

Agent task containers never receive real AI provider keys. Instead:

1. Before spawning a container, the server issues a short-lived **task token** (32 random hex bytes, 15-minute TTL)
2. The container receives this token as all three provider key env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) — not the real keys
3. All AI calls are routed to `/internal/proxy/:provider/*` on the server
4. The proxy verifies the task token, strips it, injects the real key server-side, and forwards the request
5. After the task finishes, the token is revoked — the container can no longer call any AI API
6. `docker inspect` on any agent container shows the task token (now revoked), not your OpenAI/Anthropic/Gemini key

### Recommended production stack

```env
SANDBOX_RUNTIME=runsc           # gVisor for code-execution sandbox
AGENT_RUNTIME=runsc             # gVisor for agent action-task containers
SECCOMP_PROFILE=/etc/nanoorch/seccomp/nanoorch.json
```

Plus `docker-compose.secrets.yml` for Docker secrets. This gives you all three layers simultaneously.

---

## Configuration Reference

Every secret variable below also accepts a companion `<NAME>_FILE` variant. When the `_FILE` variable is set, the app reads the value from that file path instead of the plain env var — keeping real secrets out of `docker inspect` output. See the [Security Hardening](#security-hardening) section for full details.

| Variable | `_FILE` supported | Required | Default | Description |
|----------|:-----------------:|----------|---------|-------------|
| `DATABASE_URL` | ✓ | Yes | — | PostgreSQL connection string |
| `SESSION_SECRET` | ✓ | Yes | — | Long random string for session signing |
| `POSTGRES_PASSWORD` | — | Yes | — | PostgreSQL password (used in docker-compose only) |
| `ADMIN_USERNAME` | — | No | `admin` | First admin account username |
| `ADMIN_PASSWORD` | ✓ | Yes | — | First admin account password (first-boot seed only) |
| `ENCRYPTION_KEY` | ✓ | Recommended | derived | 32-byte hex; AES-256-GCM key for credentials |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | ✓ | One required* | — | OpenAI API key |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | ✓ | One required* | — | Anthropic API key |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | ✓ | One required* | — | Gemini API key |
| `DOCKER_SOCKET` | — | No | — | Path to Docker socket; enables container execution |
| `AGENT_IMAGE` | — | No | `nanoorch-agent:latest` | Docker image for action task agent |
| `SANDBOX_IMAGE` | — | No | `nanoorch-sandbox:latest` | Docker image for code execution sandbox |
| `SANDBOX_RUNTIME` | — | No | `runsc` | OCI runtime for **code-execution sandbox** containers (`runsc` = gVisor, `runc` = standard Docker) |
| `AGENT_RUNTIME` | — | No | `runc` | OCI runtime for **agent action-task** containers (`runsc` = gVisor, blank = Docker default) |
| `SECCOMP_PROFILE` | — | No | — | Absolute host path to a custom seccomp JSON profile; applied to both agent and sandbox containers. A hardened profile is included at `agent/seccomp/nanoorch.json` |
| `COOKIE_SECURE` | — | No | `false` | Set `true` when behind an HTTPS reverse proxy (nginx/ALB); leave `false` for plain HTTP |
| `APP_PORT` | — | No | `3000` | Host port to expose |

---

## Ollama (On-Prem Inference)

Ollama lets you run models locally — no API key, no data leaving your network.

### Setup

1. [Install Ollama](https://ollama.com/download) on your server or a machine reachable from EC2
2. Pull a model:
   ```bash
   ollama pull llama3.1        # recommended — supports tool calling
   ollama pull qwen2.5         # alternative with strong tool calling
   ollama pull mistral
   ```
3. Start Ollama (it runs on port 11434 by default):
   ```bash
   ollama serve
   ```
4. In NanoOrch, create an orchestrator → select **Ollama (on-prem)** → enter the base URL (e.g. `http://192.168.1.50:11434`) → type the model name exactly as pulled

### On EC2

If Ollama is running on the same EC2 instance as NanoOrch:
```
http://host.docker.internal:11434
```

If Ollama is on a different machine in the same VPC:
```
http://<private-ip>:11434
```

Make sure port 11434 is open in the security group between the two instances.

### Tool calling support

Tool calling (Jira, GitHub, GitLab, cloud operations) only works with models that support it. Confirmed working:
- `llama3.1`, `llama3.2`
- `qwen2.5`, `qwen2.5-coder`
- `mistral-nemo`

Models like `mistral` 7B and `codellama` will respond conversationally but won't call tools.

---

## Code Execution (Sandbox)

Agents can write and run Python or JavaScript **directly from the chat** without any extra setup from the user. The code runs inside an isolated sandbox and the output streams back inline.

### How it works

1. You ask something that requires computing a result — the agent classifies it as a `code_execution` intent
2. The agent writes the code, calls the `code_interpreter` tool
3. NanoOrch spins up a short-lived Docker container with these constraints:

   | Constraint | Value |
   |---|---|
   | Runtime | `runsc` (gVisor) — syscall interception |
   | Network | **none** — no internet access |
   | Filesystem | **read-only** — nothing persists after the run |
   | Memory | 256 MB hard cap |
   | PID limit | 64 — no fork bombs |
   | Timeout | 15 seconds — auto-killed after |

4. The container runs the code and returns `stdout`, `stderr`, and exit code as JSON
5. The agent reads the output and replies to you with the result

### Build the sandbox image

On your EC2 host (once, after cloning the repo):

```bash
docker build -t nanoorch-sandbox:latest ./agent/sandbox
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_IMAGE` | `nanoorch-sandbox:latest` | Image to use for code-execution sandbox containers |
| `SANDBOX_RUNTIME` | `runsc` | OCI runtime for sandbox containers — `runsc` for gVisor, `runc` for standard Docker |
| `AGENT_RUNTIME` | _(blank)_ | OCI runtime for agent action-task containers — `runsc` to enable gVisor for those too |
| `SECCOMP_PROFILE` | _(blank)_ | Absolute host path to a custom seccomp JSON profile (applied to both agent and sandbox containers). A hardened profile is at `agent/seccomp/nanoorch.json` |

Set `SANDBOX_RUNTIME=runc` if gVisor is not installed. Code execution still works — you just lose the extra kernel-level isolation. Set `AGENT_RUNTIME=runsc` to apply gVisor to action-task agent containers as well.

---

## Integrations

Add per-workspace integrations so agents can perform real operations. All credentials are **AES-256-GCM encrypted** at rest. Navigate to **Integrations** in the sidebar.

### Integration Modes

| Mode | Behaviour |
|------|-----------|
| **Tool** | The agent explicitly calls this integration as a tool during action tasks |
| **Context** | Knowledge is automatically retrieved and injected before every AI response (RAGFlow only) |

### Cloud Providers

| Provider | Credentials | Tools |
|----------|-------------|-------|
| **AWS** | Access Key ID + Secret + Region | `aws_list_s3_buckets`, `aws_list_s3_objects`, `aws_list_ec2_instances`, `aws_list_lambda_functions`, `aws_get_cloudwatch_logs` |
| **GCP** | Service Account JSON | `gcp_list_storage_buckets`, `gcp_list_compute_instances`, `gcp_list_cloud_functions` |
| **Azure** | Client ID + Secret + Tenant ID + Subscription ID | `azure_list_resource_groups`, `azure_list_virtual_machines`, `azure_list_storage_accounts` |

### DevTools

| Provider | Credentials | Tools |
|----------|-------------|-------|
| **Jira** | Base URL + Email + API Token | `jira_list_projects`, `jira_search_issues` (JQL), `jira_get_issue`, `jira_create_issue`, `jira_update_issue`, `jira_add_comment`, `jira_list_sprints` |
| **GitHub** | Personal Access Token | `github_list_repos`, `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_list_pull_requests`, `github_create_pull_request`, `github_list_workflow_runs` |
| **GitLab** | Base URL + Token | `gitlab_list_projects`, `gitlab_list_issues`, `gitlab_get_issue`, `gitlab_create_issue`, `gitlab_list_merge_requests`, `gitlab_create_merge_request`, `gitlab_list_pipelines`, `gitlab_trigger_pipeline` |

### Knowledge Base

| Provider | Credentials | Tools / Behaviour |
|----------|-------------|-------|
| **RAGFlow** | Base URL + API Key | `ragflow_list_datasets`, `ragflow_query_dataset`, `ragflow_query_multiple_datasets`; in Context mode, auto-retrieves chunks before every AI response |

### Credential security

- AES-256-GCM encryption at rest — credentials never appear in logs
- "Test" button on every card validates the connection live without exposing the credentials
- In Docker Compose: integration credentials stay server-side and never enter the agent container

---

## Approval Gates

When an agent is about to perform a high-impact write operation it can be configured to pause and request human approval before proceeding.

### How it works

1. The agent calls the `request_approval` tool mid-task — the task pauses immediately
2. A pending approval appears in the **Approvals** section (sidebar badge shows count)
3. An admin or workspace admin reviews the request — they see the agent's proposed action and impact description
4. **Approve** — the task resumes and the action executes; **Reject** — the task is cancelled
5. The approval record remains in the history with the reviewer and timestamp

### When to use it

Configure agents with approval gate instructions for any task that:
- Creates, modifies, or deletes resources in cloud providers (AWS, GCP, Azure)
- Writes to production Jira/GitHub/GitLab projects
- Triggers deployment pipelines

---

## Pipeline / DAG Chaining

Pipelines let you chain multiple agents together sequentially, passing the output of each step as context to the next.

### Creating a pipeline

1. Open a workspace → **Pipelines** → **New Pipeline**
2. Give the pipeline a name and optional description
3. Add steps in order — each step selects an orchestrator, agent, and the prompt to send
4. Optionally configure a cron schedule and timezone for automatic execution
5. Click **Create**

### Running a pipeline

- **Manual run**: click **Run Now** on the pipeline card
- **Scheduled run**: automatic, based on the configured cron expression

Each run creates a pipeline run record with step-level status (pending → running → completed / failed). Click any run to see the per-step logs and outputs.

---

## Observability

The **Observability** page (workspace sidebar) shows token usage and cost analytics for all tasks run in the workspace.

| Section | What it shows |
|---------|--------------|
| Summary cards | Total tokens in/out, total estimated cost (all time and current period) |
| Daily usage chart | Token consumption over the last 30 days |
| Per-agent breakdown | Which agents consumed the most tokens |
| Provider/model summary | Cost breakdown by AI provider and model |

Costs are estimated based on published provider pricing. Ollama is treated as zero-cost (self-hosted).

---

## Scheduled Jobs

Create cron-based jobs that automatically run agent tasks on a schedule — no external scheduler needed.

### Setting up a scheduled job

1. Open a workspace → **Scheduled Jobs** → **New Scheduled Job**
2. Fill in:
   - **Name** — human-readable label
   - **Cron expression** — use presets (Every Hour, Every Day at Midnight, etc.) or write a custom expression
   - **Timezone** — IANA timezone (e.g. `America/New_York`)
   - **Orchestrator** — which orchestrator runs the job
   - **Prompt** — the task content sent to the agent
3. Click **Create** — the job is registered immediately

### Example use cases

- `0 9 * * 1` (Every Monday at 9am) — *"Search all open P1 Jira issues and send a summary"*
- `0 * * * *` (Every hour) — *"Check CloudWatch for ERROR-level logs in the last hour"*
- `0 8 * * *` (Every day at 8am) — *"List all GitHub PRs awaiting review and summarise them"*
- `*/15 * * * *` (Every 15 minutes) — *"Query the RAGFlow knowledge base for any new updates"*

Combine with outbound notification channels so the results are automatically posted to Slack or Teams.

---

## Outbound Notification Channels

Configure channels to push task results to external services automatically.

### Supported outbound types

| Type | Description |
|------|-------------|
| **Slack** | Posts a formatted Block Kit message to a Slack channel via Incoming Webhook |
| **Teams** | Posts an Adaptive Card to a Teams channel via Incoming Webhook |
| **Google Chat** | Posts a card message to a Google Chat space via webhook |
| **Generic Webhook** | POSTs a plain JSON payload to any URL |

### Setting up an outbound channel

1. Open an orchestrator → **Channels** → **New Channel**
2. Select the outbound type (Slack, Teams, Google Chat, or Generic Webhook)
3. Paste the webhook URL from your external service
4. Select which events trigger the notification (`task.completed`, `task.failed`, or both)
5. Click **Send Test Ping** to verify the webhook is reachable
6. Click **View Deliveries** to see the full history of sent notifications

### Getting webhook URLs

- **Slack**: Channel settings → Integrations → Incoming Webhooks → Add New Webhook
- **Teams**: Channel → Connectors → Incoming Webhook → Configure
- **Google Chat**: Space → Apps & integrations → Webhooks → Add webhook

---

## Two-way Comms — Slack & Teams Inbound

Enable a workspace as a **comms workspace** to allow agents to receive messages from Slack and Microsoft Teams and automatically reply back in the same thread or conversation.

### How it works

```
Slack / Teams user sends message
          ↓
NanoOrch events endpoint (/api/channels/:id/slack/events)
          ↓
Signature verified → prompt extracted → agent selected
          ↓
Task created → agent runs → output produced
          ↓
Reply posted back to Slack thread / Teams conversation
```

### Setup — Slack inbound

**1. Create a comms workspace**
In the Workspaces page, click **New Workspace**, toggle **Comms Workspace** on, and save.

**2. Create a Slack inbound channel**
Open an orchestrator → Channels → New Channel → type **Slack** → toggle **Enable two-way inbound** → fill in:
- **Bot Token** — from Slack App → OAuth & Permissions → Bot User OAuth Token (`xoxb-...`)
- **Signing Secret** — from Slack App → Basic Information → Signing Secret
- **Default Agent ID** — (optional) the agent ID to route messages to; falls back to the first agent

**3. Register the events endpoint with Slack**
Copy the **Events Endpoint** URL shown on the channel card and paste it in:
- Slack App → **Event Subscriptions** → Request URL
- Subscribe to bot events: `app_mention`, `message.im`

**4. Invite the bot to a Slack channel** and mention it — the agent will process the message and reply in the same thread.

### Setup — Teams inbound

**1. Register a Bot Framework app** in the [Azure Portal](https://portal.azure.com):
- Create an App Registration → note the **Application (client) ID**
- Create a client secret → note the **value**

**2. Create a Teams inbound channel** in NanoOrch:
Open an orchestrator → Channels → New Channel → type **Teams** → toggle **Enable two-way inbound** → fill in:
- **App ID** — Application (client) ID from Azure
- **App Password** — client secret value
- **Default Agent ID** — (optional)

**3. Set the messaging endpoint** in Azure Bot resource → Configuration → Messaging endpoint → paste the **Events Endpoint** URL from the channel card (`/api/channels/:id/teams/events`).

**4. Connect the bot to Teams** via the Azure Bot's Channels → Teams.

### Message routing

By default, messages go to the **Default Agent ID**. To route to a specific agent, prefix the message:

```
use my-agent-name: summarize last week's incidents
```

---

## Inbound Webhook Automation

Use inbound channels to trigger agents from external systems — for example, automatically creating a Jira issue when a Jira Service Management ticket arrives.

### Example: JSM → Jira auto-creation

1. Create an orchestrator with a Jira integration
2. Create an agent with `jira_create_issue` enabled and instructions like:
   > *"When you receive a JSM ticket payload, extract the summary, description, and priority, then call jira_create_issue to create a linked issue in project ENGINEERING. Map JSM priorities: Critical→Highest, High→High, Medium→Medium, Low→Low. Include the original JSM ticket ID in the description."*
3. Add an inbound **Webhook** channel — copy the generated URL
4. In JSM Automation: trigger = "Issue created" → action = "Send web request" → paste the NanoOrch URL
5. Done — every new JSM ticket automatically creates a linked engineering issue

Multiple agents in the same workspace can each target a different Jira project. One Jira integration (one set of credentials) serves all of them.

---

## API Overview

### Auth (public — no session required)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Login with `{ username, password }` |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Get current user (null if unauthenticated) |
| `GET` | `/api/auth/my-workspaces` | List workspaces the current user belongs to |

### Requires active session (any authenticated user)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workspaces` | List all workspaces |
| `GET` | `/api/workspaces/:id` | Get a workspace |
| `GET` | `/api/workspaces/:id/orchestrators` | List orchestrators |
| `GET` | `/api/orchestrators/:id` | Get orchestrator |
| `GET` | `/api/orchestrators/:id/agents` | List agents |
| `GET/POST` | `/api/orchestrators/:id/tasks` | List / submit tasks |
| `GET` | `/api/tasks/:id` | Get task |
| `GET` | `/api/tasks/:id/logs` | Get task logs |
| `GET` | `/api/tasks/:id/stream` | SSE stream of task logs |
| `GET` | `/api/workspaces/:id/conversations` | List conversations |
| `POST` | `/api/conversations/:id/chat` | Send chat message |

### Requires workspace admin or global admin

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/workspaces/:id/integrations` | List / create integrations |
| `GET/PUT/DELETE` | `/api/integrations/:id` | Get / update / delete integration |
| `POST` | `/api/integrations/:id/test` | Validate credentials live |
| `GET/POST` | `/api/workspaces/:id/scheduled-jobs` | List / create scheduled jobs |
| `GET/PUT/DELETE` | `/api/scheduled-jobs/:id` | Get / update / delete a scheduled job |
| `POST` | `/api/scheduled-jobs/:id/run` | Trigger job immediately |
| `GET` | `/api/workspaces/:id/approvals` | List approvals |
| `GET` | `/api/workspaces/:id/approvals/pending-count` | Count pending approvals |
| `POST` | `/api/approvals/:id/resolve` | Approve or reject a pending approval |
| `GET/POST` | `/api/workspaces/:id/pipelines` | List / create pipelines |
| `GET/PUT/DELETE` | `/api/pipelines/:id` | Get / update / delete a pipeline |
| `POST` | `/api/pipelines/:id/run` | Run a pipeline manually |
| `GET` | `/api/pipelines/:id/runs` | List pipeline run history |
| `GET` | `/api/workspaces/:id/observability` | Token usage and cost data |
| `GET` | `/api/workspaces/:id/quota` | Current resource counts vs configured limits |
| `GET` | `/api/workspaces/:id/config` | Get workspace limits config |
| `GET/POST` | `/api/workspaces/:id/members` | List / add members |
| `PATCH/DELETE` | `/api/workspaces/:id/members/:userId` | Update / remove a member |

### Requires global admin

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/workspaces` | Create a workspace |
| `PUT/DELETE` | `/api/workspaces/:id` | Update / delete a workspace |
| `POST/PUT/DELETE` | `/api/orchestrators/:id` | Create / update / delete orchestrators |
| `PUT /api/workspaces/:id/config` | | Set workspace resource limits |
| `GET/POST` | `/api/members` | List all users / create a user |
| `PUT/DELETE` | `/api/members/:id` | Update / delete a user |

### Inbound (no auth — rate-limited)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/channels/:id/webhook` | Submit a task from an external system |

---
