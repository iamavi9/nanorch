# NanoOrch — AI Agent Orchestrator Platform

## Overview

NanoOrch is a multi-tenant AI agent orchestrator platform. It provides isolated workspaces per team, multiple orchestrators per workspace (each with its own AI provider and model), agent creation and management, a task queue and real-time execution engine, and communication channels (webhooks/API keys).

## Architecture

### Stack

- **Backend**: Node.js + Express (TypeScript), running on port 5000 in dev / 3000 in Docker
- **Frontend**: React + Vite + Wouter routing + TanStack Query + shadcn/ui
- **Database**: PostgreSQL via Drizzle ORM
- **AI Providers**: OpenAI, Anthropic, Gemini, Ollama (on-prem) — configured via environment variables / Docker secrets; Ollama uses a user-supplied base URL instead of an API key
- **Task Execution**: In-process (LocalExecutor) in dev mode; Docker-isolated containers (DockerExecutor) in production via Docker socket
- **Real-time**: SSE for task log streaming; WebSocket for live log push
- **Auth**: Session-based (express-session + memorystore), password hashing via Node.js `crypto.scrypt`

### Auth & RBAC

- **Default admin**: username=`admin`, password=`admin` (override with `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars)
- **Roles**: `admin` (full dashboard access) vs `member` (chat-only access)
- **Admin routes**: `/workspaces/*` — requires session + admin role
- **Member routes**: `/member` (workspace list) and `/chat/:slug` (chat-only UI)
- **Member management**: Admin adds/removes workspace members from `/workspaces/:id/members`; creating a member creates a user account + adds to workspace
- **Auth files**: `server/lib/auth.ts` (hashing + middleware), `client/src/hooks/useAuth.ts`

### Directory Structure

```
/
├── client/                  # React frontend (Vite)
│   └── src/
│       ├── lib/
│       │   └── config.ts    # App name / branding — edit here to rebrand
│       ├── pages/           # Route pages
│       │   ├── WorkspacesPage.tsx
│       │   ├── WorkspaceDashboard.tsx
│       │   ├── OrchestratorPage.tsx
│       │   ├── AgentsPage.tsx
│       │   ├── ChannelsPage.tsx
│       │   ├── TasksPage.tsx
│       │   └── TaskDetailPage.tsx
│       └── components/
│           └── AppLayout.tsx
├── server/
│   ├── index.ts             # Express server entry
│   ├── routes.ts            # All API routes
│   ├── storage.ts           # Database storage layer (IStorage interface)
│   ├── db.ts                # Drizzle DB connection
│   ├── migrate.ts           # Programmatic migration runner
│   ├── providers/
│   │   ├── index.ts         # Unified AI provider interface
│   │   ├── openai.ts        # OpenAI provider
│   │   ├── anthropic.ts     # Anthropic provider
│   │   ├── gemini.ts        # Gemini provider
│   │   └── ollama.ts        # Ollama provider (OpenAI-compatible, custom baseURL)
│   └── engine/
│       ├── executor.ts      # Task executor (LocalExecutor + DockerExecutor)
│       ├── queue.ts         # In-memory task queue worker
│       └── scheduler.ts     # Cron scheduler stub
├── shared/
│   └── schema.ts            # Drizzle schema + Zod insert schemas
├── agent/
│   ├── Dockerfile           # Minimal agent sandbox container image
│   └── runner.js            # Agent runner (receives task via env, calls AI)
├── scripts/
│   ├── entrypoint.sh        # Docker entrypoint: load secrets → migrate → start
│   └── setup-secrets.sh     # Interactive secrets setup helper
├── migrations/              # SQL migration files (auto-generated)
├── Dockerfile               # Multi-stage production build
├── docker-compose.yml       # Production Docker Compose
├── docker-compose.override.yml  # Dev overrides
└── .env.example             # All required env vars documented
```

## Database Schema

Tables: `users`, `workspaces`, `workspace_members`, `orchestrators`, `agents`, `channels`, `tasks`, `task_logs`, `agent_memory`, `cloud_integrations`, `chat_conversations`, `chat_messages`

Primary keys: UUID (`varchar` with `gen_random_uuid()` default) for all main entities; `serial` for log/memory tables.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/workspaces` | List / create workspaces |
| GET/PUT/DELETE | `/api/workspaces/:id` | Get / update / delete workspace |
| GET | `/api/workspaces/:id/stats` | Workspace-level aggregate stats |
| GET/POST | `/api/workspaces/:id/orchestrators` | List / create orchestrators |
| GET/PUT/DELETE | `/api/orchestrators/:id` | Get / update / delete orchestrator |
| GET/POST | `/api/orchestrators/:id/agents` | List / create agents |
| GET/PUT/DELETE | `/api/agents/:id` | Get / update / delete agent |
| GET/POST | `/api/orchestrators/:id/channels` | List / create channels |
| GET/PUT/DELETE | `/api/channels/:id` | Get / update / delete channel |
| GET/POST | `/api/orchestrators/:id/tasks` | List / submit tasks |
| GET | `/api/tasks/:id` | Task status |
| GET | `/api/tasks/:id/logs` | Task logs (array) |
| GET | `/api/tasks/:id/stream` | Task log SSE stream |
| POST | `/api/channels/:id/webhook` | Public webhook receiver |
| GET | `/api/providers/models` | All models per provider |
| GET/POST | `/api/workspaces/:id/cloud-integrations` | List / create cloud integrations |
| PUT/DELETE | `/api/cloud-integrations/:id` | Update / delete integration |
| POST | `/api/cloud-integrations/:id/test` | Test credentials |

WebSocket: `ws://host/ws` — broadcasts live task log events to subscribed clients.

## AI Provider Integration

Set API keys via environment variables (or Docker secrets for production):

```
AI_INTEGRATIONS_OPENAI_API_KEY=...
AI_INTEGRATIONS_ANTHROPIC_API_KEY=...
AI_INTEGRATIONS_GEMINI_API_KEY=...
```

Supported models:
- **OpenAI**: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`
- **Anthropic**: `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- **Gemini**: `gemini-2.5-pro`, `gemini-2.5-flash`
- **Ollama**: any model pulled locally (e.g. `llama3.1`, `qwen2.5`, `mistral`, `deepseek-r1`); requires a `baseUrl` pointing to the Ollama instance (e.g. `http://localhost:11434`); no API key needed

## Task Execution

### Development (local)
Tasks run inline via `LocalExecutor` — the AI provider is called directly in the server process. No Docker required.

### Production (Docker Compose)
When `/var/run/docker.sock` is mounted, `DockerExecutor` spawns an ephemeral container from the `nanoorch-agent` image per task. The container receives the task via environment variables, calls the AI provider, writes the result to stdout, and exits. Container is removed after completion.

## Docker Compose Setup

```bash
# 1. Create secrets (interactive — generates encryption key, prompts for AI keys)
./scripts/setup-secrets.sh

# 2. Copy env file and adjust settings
cp .env.example .env

# 3. Build the agent sandbox image
docker build -t nanoorch-agent ./agent

# 4. Build and start (migrations run automatically on first boot via entrypoint.sh)
docker compose up --build
```

The `docker-compose.yml` includes:
- `app`: the main NanoOrch application (port 3000)
- `postgres`: PostgreSQL 16 with named volume and healthcheck
- Docker socket mounted for agent spawning
- Docker secrets for all API keys and encryption key
- App healthcheck on `/api/workspaces`

### Boot sequence (`scripts/entrypoint.sh`)

1. Loads secrets from `/run/secrets/*` into env vars
2. Runs `node /app/dist/migrate.cjs` — applies all pending SQL migrations from `migrations/`
3. Starts `node /app/dist/index.cjs` via `dumb-init`

## Local Development

Run with Node.js + a local PostgreSQL instance:

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL, SESSION_SECRET, and AI API keys
npm install
npm run db:push    # sync schema to local DB
npm run dev        # starts Express (port 5000) + Vite HMR
```

Schema changes: edit `shared/schema.ts` then run `npm run db:push`.

To rebrand: edit `client/src/lib/config.ts` — `APP_NAME` and `APP_TAGLINE` are the only values to change.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Express session secret (long random string) |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM credential encryption |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI API key |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Anthropic API key |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | Gemini API key |
| `DOCKER_SOCKET` | Path to Docker socket (default: `/var/run/docker.sock`) |
| `AGENT_IMAGE` | Docker image name for agent sandbox (default: `nanoorch-agent`) |
| `PORT` | Server port (default: 3000) |

## Cloud Integrations

Per-workspace cloud provider integrations that let agents perform real cloud operations via tool calling.

### Supported Providers

| Provider | Credentials | Tools |
|----------|------------|-------|
| **AWS** | Access Key ID + Secret Access Key + region | S3 (list buckets/objects), EC2 (list instances), Lambda (list functions), CloudWatch Logs |
| **GCP** | Service Account JSON (paste full key file) | Cloud Storage (list buckets), Compute Engine (list VMs), Cloud Functions (list functions) |
| **Azure** | Client ID + Client Secret + Tenant ID + Subscription ID | Resource Groups, Virtual Machines, Storage Accounts |

### Credential Encryption

- All credentials are **AES-256-GCM encrypted** before being stored in PostgreSQL
- Encryption key sourced from `ENCRYPTION_KEY` env var (or Docker secret file)
- Falls back to deriving key from `SESSION_SECRET` if `ENCRYPTION_KEY` not set
- Raw credentials are **never logged** — tool call args are sanitized before logging
- API responses never include the encrypted credential blob

### Agentic Tool-Calling Loop

When a task runs and cloud integrations are active:
1. Executor loads and decrypts credentials for the workspace
2. Builds tool list from all active integrations
3. Calls the AI provider with tool definitions
4. If AI returns tool calls → executes them server-side → appends results → re-calls AI
5. Loop repeats up to 10 rounds until AI gives a final text answer
6. Each tool call logged to task logs (with sanitized args, no credentials)

### Security Model

- Mount allowlist (`server/lib/mountAllowlist.ts`) blocks sensitive paths from being passed to agents: `.aws`, `.azure`, `.gcloud`, `.ssh`, `.env`, `credentials`, `private_key`, etc.
- Credentials never appear in task logs (scrubbed by `sanitizeToolArgs`)
- In Docker Compose production: credentials stored via **Docker secrets** at `/run/secrets/` — not as plain env vars
- Blast radius per integration is limited by your cloud IAM policies (use least-privilege service accounts)

## Features

- **Multi-tenant workspaces** — isolated environments per team
- **Multiple orchestrators per workspace** — each with its own AI provider, model, system prompt, and concurrency settings
- **Agent management** — per-orchestrator agents with individual instructions, temperature, max tokens, memory
- **Task queue** — submit tasks via UI, webhook, or API; in-memory queue dispatches to executor
- **Real-time monitoring** — SSE + WebSocket for live log streaming with color-coded levels
- **Communication channels** — webhook endpoints and API key channels
- **AI provider switcher** — switch between OpenAI, Anthropic, Gemini, and Ollama (on-prem) per orchestrator; Ollama uses a custom base URL with no API key required
- **Code execution** — agents can write and run Python/JavaScript code from chat; executed in a gVisor (`runsc`) Docker sandbox with `--network none`, `--read-only`, `--pids-limit 64`, 256 MB memory cap; `code_interpreter` tool auto-injected when intent is `code_execution`; falls back to conversational if sandbox not available
- **Docker isolation** — agent tasks run in ephemeral containers in production
- **Cloud integrations** — AWS, GCP, Azure with AES-256-GCM encrypted credentials and agentic tool calling
- **Docker secrets** — API keys and encryption key loaded from Docker secret files in production
- **Chat UI** — Per-workspace chat with `@agent` mention autocomplete and real-time SSE streaming responses
