# NanoOrch — AI Agent Orchestrator Platform

## Overview

NanoOrch is a self-hosted, multi-tenant AI agent orchestration platform. It provides isolated workspaces for teams to manage AI orchestrators and agents, execute tasks, and monitor results. The platform supports multiple AI providers (OpenAI, Anthropic, Gemini, Ollama), real-time task execution with SSE/WebSocket streaming, approval gates for human oversight, sequential pipeline/DAG chaining, and comprehensive observability with token usage tracking.

Key capabilities:
- **Multi-tenant workspaces** with per-workspace resource quotas and provider restrictions
- **3-tier RBAC**: global admin → workspace admin → member
- **Multi-provider AI**: OpenAI, Anthropic, Gemini, Ollama — configurable per orchestrator
- **Task execution**: in-process (`LocalExecutor`) or Docker-isolated (`DockerExecutor`) with LLM-based intent classification routing
- **Agent sandboxing**: gVisor (`runsc`) sandboxed containers for Python/JavaScript/bash/Ruby/Go/Java code execution
- **Approval gates**: agents pause mid-task for human sign-off via `request_approval` tool
- **Pipeline/DAG chaining**: sequential multi-step agent pipelines with step output chaining
- **Inbound channels**: webhooks, API keys, Slack, Microsoft Teams for triggering tasks
- **Two-way comms**: workspaces flagged as `isCommsWorkspace` enable Slack/Teams inbound channels that receive messages, route them to an agent, then post the reply back to the original thread/conversation (HMAC-SHA256 signature verification for Slack; JWT verification for Teams); comms thread state tracked in `comms_threads` table; tasks store `commsThreadId` for reply dispatch
- **Outbound notifications**: Slack, Teams, Google Chat, generic webhooks for task events
- **Cloud integrations**: AWS (EC2, S3, Lambda, CloudWatch), GCP, Azure, RAGFlow, Jira, GitHub, GitLab with AES-256-GCM encrypted credentials
- **Scheduled jobs**: `node-cron` based with timezone support
- **Observability**: token usage and cost tracking with Recharts dashboards

---

## User Preferences

Preferred communication style: Simple, everyday language.

---

## System Architecture

### Frontend

- **Framework**: React 18 + Vite, written in TypeScript
- **Routing**: Wouter (lightweight client-side routing)
- **Data fetching**: TanStack Query (React Query) — all API calls go through query/mutation hooks
- **UI components**: shadcn/ui (Radix UI primitives) with Tailwind CSS
- **Theme**: Light/dark mode via CSS variables; custom color palette defined in `client/src/index.css`
- **Entry point**: `client/index.html` → `client/src/main.tsx` → `client/src/App.tsx`
- **Path aliases**: `@/` maps to `client/src/`, `@shared/` maps to `shared/`

**Key pages** (in `client/src/pages/`):
- `WorkspacesPage` — workspace list with admin controls (workspace limits dialog for global admins)
- `WorkspaceDashboard` — per-workspace overview
- `OrchestratorPage`, `AgentsPage`, `TasksPage`, `TaskDetailPage`
- `ChatPage` — admin chat with `@agent` mention autocomplete
- `MemberHomePage`, `MemberChatPage` — clean chat-only UI for non-admin users at `/member` and `/chat/:slug`
- `ApprovalsPage`, `PipelinesPage`, `ObservabilityPage`, `ScheduledJobsPage`, `ChannelsPage`, `IntegrationsPage`

**AppLayout** (`client/src/components/AppLayout.tsx`): Sidebar navigation with live badge count for pending approvals (polled every 30s).

**Auth guard**: `AuthGuard` component in `App.tsx` redirects unauthenticated users to `/login`. Role checks for `adminOnly` routes.

### Backend

- **Framework**: Node.js + Express (TypeScript, ESM)
- **Entry point**: `server/index.ts` — creates HTTP server, runs DB migrations on boot, starts cron scheduler and queue worker
- **Build**: Custom `script/build.ts` using esbuild (server) + Vite (client); output to `dist/`
- **Dev mode**: `tsx server/index.ts` with Vite middleware for HMR

**Key server modules**:

| Module | Purpose |
|---|---|
| `server/routes.ts` | All Express route handlers; registers WebSocket server |
| `server/storage.ts` | Data access layer (`IStorage` interface + Drizzle implementation) |
| `server/db.ts` | Drizzle ORM + `node-postgres` pool setup |
| `server/migrate.ts` | Runs SQL migrations from `./migrations/` on boot; also runs incremental in-code `ALTER` statements for additive schema changes |
| `server/providers/` | AI provider adapters: `openai.ts`, `anthropic.ts`, `gemini.ts`, `ollama.ts` |
| `server/engine/` | Task execution pipeline |
| `server/cloud/` | Cloud integration tools and executor |
| `server/comms/` | Slack and Teams inbound/outbound handlers |
| `server/lib/` | Auth (scrypt), encryption (AES-256-GCM), secrets loader, mount allowlist |

### Task Execution Engine (`server/engine/`)

- **`queue.ts`**: Polling queue worker (2s interval). Picks up `pending` tasks, respects per-orchestrator `maxConcurrency`, dispatches to `executeTask`.
- **`executor.ts`** (`LocalExecutor`): In-process task execution. Handles tool call loops (max 10 rounds), approval gate pausing, `spawn_agent` for parallel multi-agent workflows, code execution, comms replies, outbound notifications, and token usage recording.
- **`docker-executor.ts`** (`DockerExecutor`): Docker-isolated execution for `action`-intent tasks when `DOCKER_SOCKET` is set. Spawns ephemeral containers running `agent/runner.js`. Security: issues a short-lived task token via `inference-proxy.ts` before spawning; the container receives the token instead of real API keys. Token is revoked in a `finally` block. Containers also run with `--cap-drop ALL --security-opt no-new-privileges`. Set `AGENT_RUNTIME=runsc` to enable gVisor for agent containers.
- **`sandbox-executor.ts`**: Spawns gVisor sandboxed Docker containers for code execution (Python, JS, bash, Ruby, R, Go, Java). Uses `nanoorch-sandbox:latest` image with `runsc` runtime, `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`. Set `SECCOMP_PROFILE=/host/path/nanoorch.json` to apply the custom seccomp profile (see `agent/seccomp/nanoorch.json`).
- **`scheduler.ts`**: `node-cron` based scheduler. Reads active jobs from DB, fires tasks on schedule, updates `lastRunAt`/`nextRunAt`.
- **`pipeline-executor.ts`**: Sequential pipeline execution — each step's output is prepended as context for the next step's prompt.
- **`notifier.ts`**: Outbound HTTP dispatcher for Slack/Teams/Google Chat/generic webhooks on task events.
- **`emitter.ts`**: `EventEmitter` for SSE task log streaming (`task:{taskId}` events).

### Agent Sandbox Runner (`agent/`)

- `agent/runner.js`: Runs inside ephemeral Docker containers. Receives task config via environment variables (base64-encoded JSON for messages and tools). Outputs structured JSON lines (`log`, `tool_calls`, `result`, `error`) to stdout. Supports OpenAI, Anthropic, Gemini providers.
- `agent/sandbox/runner.py`: Python script inside sandbox containers for code execution. Supports Python, JS (Node), bash, Ruby, R, Go, Java via subprocess with timeout.

### Intent Classification

LLM-based classifier determines task intent: `action` (routes to DockerExecutor), `code_execution` (routes to sandbox), or `conversational` (in-process). Classification happens before task execution.

### Authentication & Authorization

- **Session-based**: `express-session` with `connect-pg-simple` for PostgreSQL session storage
- **Password hashing**: scrypt (in `server/lib/auth.ts`)
- **3-tier RBAC**:
  - `users.role = "admin"` → global admin (can create workspaces, manage all users, set workspace limits)
  - `workspace_members.role = "admin"` → workspace admin (can manage orchestrators, agents, channels, jobs within workspace)
  - `workspace_members.role = "member"` → read-only chat access
- **Middleware**: `requireAuth`, `requireAdmin`, `requireWorkspaceAdmin` (allows global admin OR workspace admin)
- **Default admin**: `admin`/`admin` (overridden by `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars)

### Database

- **PostgreSQL** via Drizzle ORM (`drizzle-orm/node-postgres`)
- **Schema**: `shared/schema.ts` — single source of truth for all tables
- **Migrations**: File-based SQL in `./migrations/` (run automatically on boot via `server/migrate.ts`). Additive schema changes also handled by incremental in-code `ALTER TABLE IF NOT EXISTS` statements.

**Core tables**:
- `users`, `sessions` (auth)
- `workspaces`, `workspace_members`, `workspace_config` (multi-tenancy, RBAC, resource limits)
- `orchestrators`, `agents`, `agent_memory` (AI configuration)
- `tasks`, `task_logs`, `approval_requests` (task execution and approval gates)
- `channels`, `channel_deliveries` (inbound/outbound comms)
- `cloud_integrations` (encrypted credentials for AWS/GCP/Azure/Jira/GitHub/GitLab/RAGFlow/Teams)
- `chat_conversations`, `chat_messages` (persistent chat history)
- `scheduled_jobs` (cron jobs)
- `pipelines`, `pipeline_steps`, `pipeline_runs`, `pipeline_step_runs` (DAG chaining)
- `token_usage` (observability — input/output tokens + cost per task)
- `comms_threads` (Slack/Teams conversation threading)

### Data Security

- **Credential encryption**: AES-256-GCM via `server/lib/encryption.ts`. Key derived from `ENCRYPTION_KEY` env var (hex) or via scrypt from `SESSION_SECRET`.
- **Secret loading**: `server/lib/secrets.ts` supports Docker secrets (file path via `{NAME}_FILE` env var) or direct env vars.
- **Mount allowlist**: `server/lib/mountAllowlist.ts` blocks sensitive paths (`.aws`, `.ssh`, credentials files) from Docker volume mounts. Also sanitizes tool argument logs for sensitive field names.
- **CSRF token**: Stored in session, validated on state-mutating requests.
- **Inference proxy** (`server/proxy/inference-proxy.ts`): Agent containers never receive real AI API keys. Instead, `issueTaskToken(taskId)` generates a 64-char random hex token valid for 15 minutes; this token is passed as the provider key env var. The proxy at `POST /internal/proxy/:provider/*path` verifies the token, strips it, injects the real key server-side, and pipes the response (including SSE streams) back to the container. Tokens are revoked in a `finally` block after task completion. **`docker inspect` on any agent container will show only the short-lived task token, never a real API key.**
- **Container hardening** (both agent and code-execution containers): `--cap-drop ALL` drops all Linux capabilities; `--security-opt no-new-privileges` prevents setuid escalation. Optional `SECCOMP_PROFILE` env var applies a custom syscall allowlist (`agent/seccomp/nanoorch.json`). Code-execution containers additionally use `--network none --read-only` and gVisor (`--runtime runsc`).

### Real-time Communication

- **SSE**: Task log streaming via `GET /api/tasks/:id/stream` — emits `taskLogEmitter` events to clients
- **WebSocket** (`ws` library): Live log push; WebSocket server attached to the HTTP server in `routes.ts`

### Build & Deployment

- **Dev**: `npm run dev` — `tsx server/index.ts` with embedded Vite middleware (HMR)
- **Production build**: `npm run build` — Vite builds frontend to `dist/public/`, esbuild bundles server to `dist/index.cjs`
- **Production start**: `npm start` — `node dist/index.cjs`
- **DB migrations**: `npm run db:push` (Drizzle Kit) or automatic on server boot

---

## External Dependencies

### AI Providers
- **OpenAI** (`openai` SDK) — GPT-4o, GPT-4o-mini, GPT-4-turbo; also used for Ollama (OpenAI-compatible API)
- **Anthropic** (`@anthropic-ai/sdk`) — Claude Opus/Sonnet/Haiku
- **Google Gemini** (`@google/genai`) — Gemini 2.5 Pro/Flash
- **Ollama** — Self-hosted; uses OpenAI-compatible SDK pointing to local endpoint

API keys loaded via `loadSecret()`: `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_GEMINI_API_KEY`. Base URLs configurable via corresponding `*_BASE_URL` env vars.

### Cloud Integrations
- **AWS**: `@aws-sdk/client-ec2`, `@aws-sdk/client-s3`, `@aws-sdk/client-sts`, `@aws-sdk/client-lambda`, `@aws-sdk/client-cloudwatch-logs`
- **GCP**: `@google-cloud/storage`, `googleapis`
- **Azure**: `@azure/identity`, `@azure/arm-compute`, `@azure/arm-resources`, `@azure/arm-storage`
- **Jira**: REST API (fetch-based)
- **GitHub**: REST API (fetch-based)
- **GitLab**: REST API (fetch-based)
- **RAGFlow**: REST API (fetch-based) — knowledge base query and context injection

### Database & Session
- **PostgreSQL**: Primary data store (requires `DATABASE_URL` env var)
- **`pg`** (node-postgres): Connection pooling
- **`drizzle-orm`**: ORM + query builder
- **`connect-pg-simple`**: PostgreSQL-backed session store
- **`express-session`**: Session management

### Infrastructure
- **Docker**: Required for `DockerExecutor` (action tasks) and sandbox code execution. Controlled by `DOCKER_SOCKET` env var.
- **gVisor (`runsc`)**: Container runtime for sandboxed code execution. Configured via `SANDBOX_RUNTIME` env var (default: `runsc`).
- **`node-cron`**: In-process cron scheduler
- **`cron-parser`**: Cron expression parsing for next-run calculation

### Communication Platforms
- **Slack**: Inbound events (HMAC signature verification) + outbound via `chat.postMessage` API
- **Microsoft Teams**: Inbound Bot Framework events (JWT verification) + outbound via Bot Framework REST API

### Other Libraries
- **`ws`**: WebSocket server
- **`nanoid`**: ID generation
- **`zod`** + **`drizzle-zod`**: Schema validation
- **`express-rate-limit`**: API rate limiting
- **`recharts`**: Observability charts (frontend)
- **`date-fns`**: Date formatting

### Environment Variables Required
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Express session signing key |
| `ENCRYPTION_KEY` | AES-256-GCM key for credential encryption (64-char hex) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI API key |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Anthropic API key |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | Gemini API key |
| `DOCKER_SOCKET` | Docker socket path (enables DockerExecutor + sandbox) |
| `SANDBOX_IMAGE` | Docker image for code sandbox (default: `nanoorch-sandbox:latest`) |
| `SANDBOX_RUNTIME` | Container runtime for sandbox (default: `runsc`) |
| `AGENT_RUNTIME` | Container runtime for agent containers — set to `runsc` to enable gVisor (default: unset → `runc`) |
| `SECCOMP_PROFILE` | Host path to seccomp JSON applied to both containers — see `agent/seccomp/nanoorch.json` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Override default admin credentials |