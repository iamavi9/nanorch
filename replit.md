# NanoOrch — AI Agent Orchestrator Platform

## Overview
NanoOrch is a self-hosted, multi-tenant AI agent orchestration platform designed for teams. It provides isolated workspaces for managing AI orchestrators and agents, executing tasks, and monitoring results. The platform supports multiple AI providers (OpenAI, Anthropic, Gemini, Ollama, vLLM), real-time task execution with streaming, and human approval gates via interactive messages in communication platforms. It features sequential pipeline/DAG chaining, comprehensive observability with token usage tracking, and utilization threshold alerts. Key capabilities include multi-tenant workspaces with RBAC, multi-provider AI configuration with model failover and task retry, secure task execution using `LocalExecutor`, `DockerExecutor`, or `K3sExecutor` with gVisor sandboxing, and various inbound channels (webhooks, APIs, Slack, Microsoft Teams, Google Chat). Agents support two-way communication, chat commands, and per-thread history. The platform also offers cloud integrations (AWS, GCP, Azure, Jira, GitHub, GitLab, RAGFlow), messaging integrations as agent tools (MS Teams, Slack, Google Chat), and scheduled jobs, event triggers, and channel-based delivery for monitoring and notifications.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Frameworks**: React 18 + Vite (TypeScript), Wouter for routing, TanStack Query for data fetching.
- **UI/UX**: shadcn/ui (Radix UI primitives) with Tailwind CSS, light/dark mode via CSS variables.
- **Core Pages**: Workspaces, Workspace Dashboard, Orchestrators, Agents, Tasks, Chat, Approvals, Pipelines, Observability, Scheduled Jobs, Channels, Integrations, Triggers, Git Repos, Git Agents, and API key management. Public marketing page at `/pricing` (no auth required).
- **Layout**: Collapsible sidebar with state persistence and Radix Tooltips.
- **Authentication**: `AuthGuard` for redirects and role-based access control.

### Backend
- **Framework**: Node.js + Express (TypeScript, ESM).
- **Core Modules**:
    - **Data Access**: `Drizzle` ORM with `node-postgres`.
    - **AI Providers**: Adapters for various AI services.
    - **Task Engine**: Core pipeline for task execution.
    - **Integrations**: Cloud and communication platform handlers.
    - **Security**: Authentication (scrypt), encryption (AES-256-GCM), secrets loading.

### Task Execution Engine
- **Queue**: Polling worker for task dispatch and concurrency management.
- **Executors**:
    - `LocalExecutor`: In-process execution, manages tool calls, approvals, parallel agent workflows, code execution, notifications, and token usage. Supports model failover, task retry, bypass approval, comms thread history, and parallel multi-agent delegation.
    - `DockerExecutor`: Docker-isolated execution for `action`-intent tasks using ephemeral containers.
    - `K3sExecutor`: K3s OpenShell-style isolation for agent invocations as Kubernetes Jobs in an embedded K3s cluster with restricted network policies.
    - `SandboxExecutor`: gVisor-sandboxed Docker containers for secure code execution (Python, JS, bash, Ruby, R, Go, Java) with strict security policies.
- **Scheduler**: `node-cron` for scheduled jobs.
- **Pipeline Executor**: Manages sequential pipeline execution and output chaining.
- **Notifier**: Dispatches outbound notifications.
- **Emitter**: `EventEmitter` for SSE task log streaming.

### Vector Memory System (pgvector)
- **Database**: PostgreSQL + pgvector extension (v0.8.0), `agent_memory_vectors` table with `vector(1536)` column and HNSW cosine index.
- **Embedding**: `server/lib/embeddings.ts` — OpenAI `text-embedding-3-small` (1536 dims) with Gemini `text-embedding-004` (outputDimensionality=1536) fallback; gracefully skips if no provider configured.
- **Retrieval**: On task start (if `memoryEnabled=true`), embeds the task input, finds top-5 semantically similar past outputs (cosine similarity ≥ 0.70), injects into context as system messages.
- **Storage**: On task completion (fire-and-forget), embeds the output and writes to `agent_memory_vectors` with source=`task_output`.
- **Coverage**: All three executors (Local, Docker, K3s) implement both retrieval and storage hooks.
- **Isolation**: Scoped per `agent_id + workspace_id`. Parallel multi-agent runs passively learn from each other's prior outputs across sessions.

### Agent Sandbox Runner
- `agent/runner.js` and `agent/sandbox/runner.py` handle task configuration processing and structured log output within Docker containers.

### Intent Classification
- LLM-based classification routes tasks to `action`, `code_execution`, or `conversational` intents.
- Manual override for intent classification and bypass approval flags available for scheduled jobs.

### Authentication & Authorization
- **Session-based**: `express-session` with Redis or PostgreSQL store.
- **Password Hashing**: scrypt.
- **3-tier RBAC**: Global admin, Workspace admin, Member roles.
- **ServiceNow integration**: Agents can interact with ITSM records.
- **PostgreSQL integration**: Agents can query and execute against external PostgreSQL databases via 5 tools (`pg_list_schemas`, `pg_list_tables`, `pg_describe_table`, `pg_query` read-only, `pg_execute` write with approval gate). Connection string stored AES-256-GCM encrypted.
- **Kubernetes integration**: Agents can manage Kubernetes clusters via 45 tools across 9 categories (Cluster, Workloads, Services/Networking, Config/Secrets, Storage, Jobs/CronJobs, DaemonSets, Helm-via-secrets, Manifests/Observability). Pure Node.js HTTP client — no external k8s library. Supports bearer token + optional CA cert (direct mode) or kubeconfig JSON. Credentials encrypted AES-256-GCM. Tools use `kube_` prefix; Helm tools use `kube_helm_*`.
- **SSO**: OIDC and SAML 2.0 support with automatic user provisioning.

### Database
- **PostgreSQL**: Primary data store, managed by Drizzle ORM, with schema defined in `shared/schema.ts`.
- **Migrations**: File-based SQL migrations run automatically on boot.
- **Core Tables**: `users`, `workspaces`, `orchestrators`, `agents`, `tasks`, `channels`, `cloud_integrations`, `chat_conversations`, `scheduled_jobs`, `pipelines`, `token_usage`, `comms_threads`, `sso_providers`, `event_triggers`, `trigger_events`, `git_repos`, `git_agents`, `git_agent_runs`, `provider_keys`.

### Data Security
- **Credential Encryption**: AES-256-GCM.
- **Secret Management**: Supports Docker secrets and environment variables.
- **Mount Allowlist**: Blocks sensitive paths from Docker mounts.
- **CSRF Protection**: Token validation for state-mutating requests, with exemptions for inbound webhooks and SSO callbacks.
- **Inference Proxy**: Agents receive short-lived task tokens; real AI API keys are managed server-side.
- **Container Hardening**: Docker containers run with stringent security options and gVisor.

### Real-time Communication
- **SSE**: Task log streaming.
- **WebSocket**: Live log push.

### Build & Deployment
- Development with Vite HMR.
- Production build and run process.
- Automated DB migrations on server boot.

### Git Agent System (Repo-Driven Automation)
- **Git Repos** (`git_repos`): Connects GitHub/GitLab repositories with encrypted PAT/token, unique HMAC-signed webhook endpoint, and `.nanoorch.yml` tracking.
- **Git Agents** (`git_agents`): Admin-controlled agents triggered by repo events. Developers can only enable/disable via `.nanoorch.yml`; admins control system prompts, tools, approval config, and feedback settings.
- **Repo Cloning** (`server/engine/git-clone.ts`): Shallow HTTPS clone with branch fallback and SHA checkout. Binary file detection, 60 KB total / 10 KB per-file content cap. File context injected into task input.
- **Sandbox Routing**: Git-agent tasks (intent `git-agent:*`) route to K3s/Docker sandboxes. Cloned repo mounted as read-only volume (`/workspace`) for Docker; file content embedded in prompt for K3s/LLM paths.
- **Developer Feedback Loop** (`server/engine/git-feedback.ts`): After each successful run, findings are posted back to GitHub as a PR/commit comment or GitLab as an MR/commit note. Comms channel notification dispatched via existing `notifyChannelId` mechanism. Both configurable per-agent. Comments formatted as Markdown with NanoOrch branding.
- **Run History** (`git_agent_runs`): Per-webhook execution records with status (pending/running/completed/skipped/failed), skip reasons, and task linkage.

### Event-Driven Triggers
- Webhook triggers for firing AI agent tasks on external events from sources like GitHub, GitLab, and Jira.
- Supports payload templating for agent prompts.

## External Dependencies

### AI Providers
- OpenAI
- Anthropic
- Google Gemini
- Ollama (local / remote; custom baseUrl)
- vLLM (self-hosted GPU cluster; OpenAI-compatible REST API; per-orchestrator AES-256-GCM encrypted API key; base URL convention: enter without `/v1`, appended automatically; `VLLM_API_KEY` + `VLLM_BASE_URL` injected into Docker/K3s agent containers)

### Cloud Integrations
- AWS (EC2, S3, STS, Lambda, CloudWatch SDKs)
- GCP (`@google-cloud/storage`, `googleapis`)
- Azure (`@azure/identity`, `@azure/arm-compute`, `@azure/arm-resources`, `@azure/arm-storage`)
- Jira
- GitHub
- GitLab
- RAGFlow
- MS Teams (messaging tool via incoming webhooks)
- Slack (messaging tool via Bot Token)
- Google Chat (messaging tool via incoming webhooks)

### Database & Session
- PostgreSQL (`pg`, `drizzle-orm`, `connect-pg-simple`)
- Redis (`ioredis`, `connect-redis`)

### Infrastructure
- Docker
- gVisor (`runsc`)
- `node-cron`
- `cron-parser`

### Communication Platforms (Two-way Comms Channels)
- Slack
- Microsoft Teams
- Google Chat

### Other Libraries
- `ws` (WebSocket server)
- `nanoid` (ID generation)
- `zod`, `drizzle-zod` (schema validation)
- `express-rate-limit`
- `recharts` (frontend data visualization)
- `openid-client` (OIDC for SSO)
- `@node-saml/node-saml` (SAML for SSO)
- `date-fns`