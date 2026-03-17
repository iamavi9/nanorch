# NanoOrch — AI Agent Orchestrator Platform

A self-hosted, multi-tenant platform for orchestrating AI agents across OpenAI, Anthropic, Gemini, and **on-prem Ollama** — with session-based auth, role-based access control, Docker-isolated task execution, real-time monitoring, cloud integrations (AWS/GCP/Azure/RAGFlow), and a chat UI with `@agent` mentions.

---

## Features

- **Auth & RBAC** — session-based username/password login; `admin` role gets the full dashboard, `member` role gets a clean chat-only interface
- **Multi-tenant workspaces** — isolated environments per team or project
- **Member management** — admins create member accounts and assign them to workspaces
- **Multiple orchestrators** — each workspace can have multiple orchestrators with its own AI provider, model, and system prompt
- **Agent management** — create agents per orchestrator with individual instructions, temperature, memory, and tool access
- **Task queue** — submit tasks via UI, webhook endpoint, or API key channel; real-time SSE log streaming
- **AI provider switcher** — OpenAI, Anthropic, Gemini, and Ollama (on-prem); swap per orchestrator
- **Docker-isolated execution** — when a user approves a write action (create/modify/delete), it runs inside an ephemeral container; conversational tasks stay in-process
- **Code execution** — agents write and run Python/JavaScript directly from chat inside a gVisor (`runsc`) sandbox container; fully network-isolated, read-only filesystem, memory/CPU capped
- **Cloud integrations** — AWS, GCP, Azure, and RAGFlow with AES-256-GCM encrypted credentials; two modes: **Tool** (agent calls them explicitly) and **Context** (RAGFlow auto-retrieves knowledge before every AI response)
- **Chat UI** — per-workspace chat with `@agent` mention autocomplete (keyboard ↑↓ navigation, Enter/Tab to select) and live streaming responses
- **Member chat interface** — clean chat page at `/chat/:slug` for end-users (no admin UI visible)

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

---

### 5. Build the agent images

**Action task agent** — used for isolated cloud action tasks:
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

```bash
docker compose up -d
```

Database migrations run automatically on first boot. Check the logs:

```bash
docker compose logs -f app
```

Look for:
```
[NanoOrch] Running database migrations...
[NanoOrch] Starting server...
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

### Roles

| Role | Access |
|------|--------|
| `admin` | Full dashboard — workspaces, orchestrators, agents, tasks, cloud integrations, members |
| `member` | Chat-only — list of assigned workspaces and `/chat/:slug` per workspace |

### Default admin

On first boot, if no admin exists, one is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in your `.env`. This only runs once — changing the env var later won't change an existing account.

### Adding members

1. Log in as admin → open a workspace → **Members** in sidebar
2. Click **Add Member** — set username, display name, password, role
3. Member logs in at `/login` and sees their assigned workspaces

---

## How Docker task isolation works

When a user sends a message like `@agent create an S3 bucket`, the chat flow:

1. Intent is classified — detected as `"action"` (a write operation)
2. A confirmation card is shown — the user must approve
3. On approval, a task is created with `intent = "action"`
4. In Docker Compose (where `DOCKER_SOCKET` is set), the task executor spawns:
   ```
   docker run --rm --memory 512m --cpus 0.5 nanoorch-agent:latest
   ```
5. The container runs **one round** of AI inference — if the AI requests cloud tool calls, the container returns them to the server, the server executes the cloud tools in-process (credentials never enter the container), then spawns the next container round with updated context
6. The container exits and is removed automatically after each round

Conversational messages (`@agent explain what S3 is`) run in-process with no container overhead.

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
│  Session Auth        REST API          Task Engine               │
│  (requireAuth /      /api/auth/*       Queue Worker              │
│   requireAdmin)      /api/workspaces/* runAgent()                │
│                      /api/members/*    Tool Calling Loop         │
│                                        SSE Stream                │
└───────┬─────────────────────┬────────────────────┬──────────────┘
        │                     │                    │
        ▼                     ▼                    ▼
  PostgreSQL          AI Providers          Cloud / RAG APIs
  (Drizzle ORM)       OpenAI                AWS / GCP / Azure
  users               Anthropic             RAGFlow
  workspaces          Gemini
  tasks               Ollama (on-prem)
  cloud_integrations
        │
        ▼
  Docker Socket (/var/run/docker.sock)
        │
        ▼  (action tasks only)
  docker run --rm nanoorch-agent:latest
  Ephemeral container per AI inference round
  AI keys injected via env vars
  Cloud credentials stay on server
```

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | — | Long random string for session signing |
| `POSTGRES_PASSWORD` | Yes | — | PostgreSQL password |
| `ADMIN_USERNAME` | No | `admin` | First admin account username |
| `ADMIN_PASSWORD` | Yes | — | First admin account password |
| `ENCRYPTION_KEY` | Recommended | derived | 32-byte hex; AES-256-GCM key for cloud credentials |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | One required* | — | OpenAI API key |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | One required* | — | Anthropic API key |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | One required* | — | Gemini API key |
| `DOCKER_SOCKET` | No | — | Path to Docker socket; enables container execution |
| `AGENT_IMAGE` | No | `nanoorch-agent:latest` | Docker image for action task agent |
| `SANDBOX_IMAGE` | No | `nanoorch-sandbox:latest` | Docker image for code execution sandbox |
| `SANDBOX_RUNTIME` | No | `runsc` | Docker runtime for sandbox (`runsc` = gVisor, `runc` = standard Docker) |
| `APP_PORT` | No | `3000` | Host port to expose |

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

Tool calling (RAGFlow queries, cloud operations) only works with models that support it. Confirmed working:
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

### What the agent can run

| Language | Capabilities |
|---|---|
| **Python 3.12** | Full standard library, `math`, `json`, `datetime`, `re`, `itertools`, etc. |
| **Node.js 20** | Full built-in modules (`fs` excluded at runtime), `crypto`, `util`, etc. |

Neither runtime has internet access or the ability to write files that persist outside the container.

### Build the sandbox image

On your EC2 host (once, after cloning the repo):

```bash
docker build -t nanoorch-sandbox:latest ./agent/sandbox
```

Verify it works:
```bash
docker run --rm --runtime=runsc \
  -e CODE_B64=$(echo 'print(2 ** 32)' | base64 -w0) \
  -e LANGUAGE=python \
  nanoorch-sandbox:latest
# Expected output: {"stdout":"4294967296\n","stderr":"","exit_code":0}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_IMAGE` | `nanoorch-sandbox:latest` | Image to use for code runs |
| `SANDBOX_RUNTIME` | `runsc` | Docker runtime — `runsc` for gVisor, `runc` for plain Docker |

Set `SANDBOX_RUNTIME=runc` if gVisor is not installed. Code execution still works — you just lose the extra kernel-level isolation.

### Example prompts that trigger code execution

```
@agent calculate the compound interest on $10,000 at 5% over 20 years
@agent parse this JSON and count how many items have status "active": [...]
@agent generate a Fibonacci sequence up to 1000
@agent what is the SHA-256 hash of "hello world"?
@agent convert 98.6°F to Celsius
```

The chat UI shows a pulsing indicator while the sandbox is running:
```
⚙ running python in sandbox…
```
It clears automatically when the result arrives.

### Security considerations

- The sandbox has **zero network access** — it cannot exfiltrate data or make external calls
- The read-only filesystem prevents persistent writes
- gVisor intercepts all Linux syscalls before they reach the host kernel — even if the code exploits a container escape, it still hits gVisor's userspace kernel
- Memory and PID limits prevent resource exhaustion
- Each run is in a fresh container — no state carries over between requests

---

## Cloud Integrations

Add per-workspace cloud credentials so agents can perform real operations. All credentials are **AES-256-GCM encrypted** at rest. Navigate to **Integrations** in the sidebar.

### Integration Modes

Each integration has a **mode** that controls how the agent uses it:

| Mode | Behaviour |
|------|-----------|
| **Tool** | The agent explicitly calls this integration as a tool during action tasks (AWS, GCP, Azure default to this) |
| **Context** | Knowledge is automatically retrieved and injected into the system prompt before every AI response — no explicit tool call needed (RAGFlow defaults to this) |

- Tool-mode integrations appear in the **Tool Integrations** section and trigger the action confirmation flow when the agent decides to use them.
- Context-mode integrations appear in the **Context Integrations** section; for RAGFlow this means every chat response automatically gets relevant document chunks prepended, with cited sources shown in a collapsible panel.

You can change the mode of any integration at any time from the **Edit** dialog — without touching credentials.

### Editing an integration

Click the **Edit** (pencil) button on any integration card to:
- Rename the integration
- Switch its mode (Tool ↔ Context)
- Optionally rotate credentials — leave credential fields blank to keep the existing encrypted values

### Providers and tools

| Provider | Credentials | Default mode | Agent tools |
|----------|-------------|--------------|-------------|
| **AWS** | Access Key ID + Secret + Region | Tool | `aws_list_s3_buckets`, `aws_list_s3_objects`, `aws_list_ec2_instances`, `aws_list_lambda_functions`, `aws_get_cloudwatch_logs` |
| **GCP** | Service Account JSON | Tool | `gcp_list_storage_buckets`, `gcp_list_compute_instances`, `gcp_list_cloud_functions` |
| **Azure** | Client ID + Secret + Tenant ID + Subscription ID | Tool | `azure_list_resource_groups`, `azure_list_virtual_machines`, `azure_list_storage_accounts` |
| **RAGFlow** | Base URL + API Key | Context | `ragflow_list_datasets`, `ragflow_query_dataset`, `ragflow_query_multiple_datasets` |

---

## API Overview

### Auth (public)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Login with `{ username, password }` |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Get current user (null if unauthenticated) |
| `GET` | `/api/auth/my-workspaces` | List workspaces the current user belongs to |

### Admin (requires admin session)

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/workspaces` | List / create workspaces |
| `GET/POST/DELETE` | `/api/workspaces/:id/members` | Manage workspace members |
| `GET/POST` | `/api/workspaces/:id/orchestrators` | List / create orchestrators |
| `GET/POST` | `/api/orchestrators/:id/agents` | List / create agents |
| `GET/POST` | `/api/orchestrators/:id/tasks` | List / submit tasks |
| `GET` | `/api/tasks/:id/stream` | SSE stream of task logs |
| `GET/POST` | `/api/workspaces/:id/integrations` | List / create integrations |
| `PUT` | `/api/integrations/:id` | Update name, mode, or credentials |
| `DELETE` | `/api/integrations/:id` | Remove an integration |
| `POST` | `/api/integrations/:id/test` | Validate cloud credentials |

### Public

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/channels/:id/webhook` | External webhook receiver |

WebSocket: `ws://host/ws` — live task log events (requires active session cookie).

---

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env: set DATABASE_URL, SESSION_SECRET, and at least one AI provider key

npm run db:push   # sync database schema
npm run dev       # Express on :5000, Vite HMR on :5173
```

Default admin (`admin` / `admin`) is created automatically on first start if no admin exists.

In dev mode, tasks execute in-process (no Docker needed). The Docker executor only activates when `DOCKER_SOCKET` is set.

### Running with Docker locally

Use `docker-compose.dev.yml` for local Docker development — it mounts source code and runs the dev server:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

> **Important:** Do NOT run plain `docker compose up` in the cloned repo without specifying `-f docker-compose.yml` — Docker Compose will never auto-apply `docker-compose.dev.yml` since it is not named `docker-compose.override.yml`. On EC2, always use:
> ```bash
> docker compose up -d
> ```

### Schema changes

Edit `shared/schema.ts`, then:

```bash
npm run db:push
```

### Rebrand

Edit `client/src/lib/config.ts`:

```ts
export const APP_NAME = "NanoOrch";
export const APP_TAGLINE = "Agent Platform";
```

---

## Adding New Cloud Tools

Two files control the cloud tool system:

| File | Role |
|------|------|
| `server/cloud/tools.ts` | Declares the tool schema — name, description, parameters |
| `server/cloud/executor.ts` | Implements the actual SDK/HTTP call for each tool |

Tool naming: `{provider}_{verb}_{resource}` — e.g. `aws_create_eks_cluster`, `ragflow_query_dataset`.

Append to the provider array in `tools.ts`, add the `if (name === "...")` branch in `executor.ts`. That's it.

---

## Security Notes

- Passwords hashed with `crypto.scrypt` — no plaintext storage
- Cloud credentials AES-256-GCM encrypted before hitting the database
- Action tasks run in ephemeral containers; cloud credentials never enter the container
- Set strong `SESSION_SECRET`, `ADMIN_PASSWORD`, and `POSTGRES_PASSWORD` before production
- Use least-privilege IAM roles for cloud integrations

---

## License

MIT
