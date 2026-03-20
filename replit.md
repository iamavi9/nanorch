# NanoOrch — AI Agent Orchestrator Platform

## Overview
NanoOrch is a self-hosted, multi-tenant AI agent orchestration platform designed for teams. It provides isolated workspaces to manage AI orchestrators and agents, execute tasks, and monitor results. The platform supports multiple AI providers (OpenAI, Anthropic, Gemini, Ollama), real-time task execution with streaming, approval gates for human oversight (including interactive Slack Block Kit / Teams Adaptive Card approval buttons in comms threads), and sequential pipeline/DAG chaining. It also offers comprehensive observability with token usage tracking and utilization threshold alerts. Key features include multi-tenant workspaces with RBAC, multi-provider AI configuration with per-orchestrator model failover and task retry (exponential backoff), secure task execution via `LocalExecutor` or `DockerExecutor` with gVisor sandboxing, inbound channels (webhooks, API keys, Slack, Microsoft Teams, Google Chat), two-way communication for agents (with DM allowlist, bypass-approval phrases, chat commands, typing indicators, image notes, per-thread history), channel-based delivery for heartbeat monitors, scheduled jobs, pipelines, and event triggers, outbound notifications, cloud integrations (AWS, GCP, Azure, Jira, GitHub, GitLab, RAGFlow), and scheduled jobs.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 + Vite (TypeScript)
- **Routing**: Wouter
- **Data fetching**: TanStack Query
- **UI**: shadcn/ui (Radix UI primitives) with Tailwind CSS
- **Theming**: Light/dark mode via CSS variables
- **Core Pages**: Workspaces, Workspace Dashboard, Orchestrators, Agents, Tasks, Chat, Approvals, Pipelines, Observability, Scheduled Jobs, Channels, Integrations, Triggers.
- **Layout**: `AppLayout` provides sidebar navigation with live approval badge counts.
- **Authentication**: `AuthGuard` handles redirects for unauthenticated users and enforces role-based access for admin-only routes.

### Backend
- **Framework**: Node.js + Express (TypeScript, ESM)
- **Entry Point**: `server/index.ts` handles server setup, DB migrations, cron scheduler, and queue worker.
- **Build**: Custom `script/build.ts` using esbuild (server) and Vite (client).
- **Key Modules**:
    - `server/routes.ts`: Express route handlers and WebSocket server.
    - `server/storage.ts`: Data access layer with `Drizzle` ORM.
    - `server/db.ts`: Drizzle ORM and `node-postgres` pool setup.
    - `server/migrate.ts`: Database migration management.
    - `server/providers/`: AI provider adapters.
    - `server/engine/`: Core task execution pipeline.
    - `server/cloud/`: Cloud integration tools.
    - `server/comms/`: Slack, Teams, and Google Chat inbound/outbound handlers.
    - `server/lib/`: Authentication (scrypt), encryption (AES-256-GCM), secrets loading, and mount allowlist.

### Task Execution Engine
- **Queue**: Polling worker (`queue.ts`) handles task dispatch based on concurrency limits.
- **Executors**:
    - `LocalExecutor`: In-process execution, manages tool calls, approvals, parallel agent workflows, code execution, notifications, and token usage. Supports: model failover (failoverProvider/failoverModel on orchestrator), task retry with exponential backoff (up to maxRetries), bypass approval flag (skips request_approval tool when set), comms thread history loading/saving (last 50 messages), approval card dispatch for comms threads, and **parallel multi-agent delegation** (`spawn_agent` tool — automatically included when orchestrator has 2+ agents; multiple spawn_agent calls in one response run in parallel via Promise.allSettled; child tasks linked to parent via parentTaskId).
    - `DockerExecutor`: Docker-isolated execution for `action`-intent tasks, using ephemeral containers with short-lived task tokens for security.
    - `SandboxExecutor`: Spawns gVisor-sandboxed Docker containers for secure code execution (Python, JS, bash, Ruby, R, Go, Java) with strict security policies (`--cap-drop ALL`, `--security-opt no-new-privileges`, `--network none`, `--read-only`, `runsc` runtime, seccomp profiles).
- **Scheduler**: `node-cron` based for scheduled jobs.
- **Pipeline Executor**: Manages sequential pipeline execution, chaining outputs between steps.
- **Notifier**: Dispatches outbound notifications to various platforms.
- **Emitter**: `EventEmitter` for SSE task log streaming.

### Agent Sandbox Runner
- `agent/runner.js`: Executes within Docker containers, processing task configurations and outputting structured logs.
- `agent/sandbox/runner.py`: Python script for code execution within sandboxed containers, supporting multiple languages.

### Intent Classification
- LLM-based classification routes tasks to `action` (DockerExecutor), `code_execution` (sandbox), or `conversational` (in-process).

### Authentication & Authorization
- **Session-based**: `express-session` with PostgreSQL storage.
- **Password Hashing**: scrypt.
- **3-tier RBAC**: Global admin, Workspace admin, Member roles with corresponding middleware for access control.
- **Default Admin**: Configurable via environment variables.
- **SSO (OIDC + SAML)**: `server/lib/sso.ts` handles OIDC discovery (openid-client v6) and SAML SP/ACS flows (@node-saml/node-saml). Global admin manages providers via `/admin/sso`. Login page auto-fetches active providers for one-click SSO buttons. Auto-provisions new users on first SSO login using `defaultRole` from provider config. CSRF exemptions applied for SSO callback routes.

### Database
- **PostgreSQL**: Primary data store, managed by Drizzle ORM.
- **Schema**: Defined in `shared/schema.ts`.
- **Migrations**: File-based SQL migrations run automatically on boot.
- **Core Tables**: `users`, `workspaces`, `workspace_config`, `orchestrators`, `agents`, `tasks`, `channels`, `cloud_integrations`, `chat_conversations`, `scheduled_jobs`, `pipelines`, `token_usage`, `comms_threads`, `sso_providers`, `event_triggers`, `trigger_events`.
- **Migration Strategy**: INCREMENTAL_MIGRATIONS in `server/migrate.ts` — NEVER use `db:push --force` (would DROP `_nanoorch_migrations` and `user_sessions` tables that are not in the Drizzle schema).

### Data Security
- **Credential Encryption**: AES-256-GCM for sensitive data using `ENCRYPTION_KEY`.
- **Secret Loading**: Supports Docker secrets and environment variables.
- **Mount Allowlist**: Blocks sensitive paths from Docker mounts and sanitizes logs.
- **CSRF Protection**: Token validation for state-mutating requests.
- **Inference Proxy**: Agents receive short-lived task tokens instead of real AI API keys, with the proxy handling real key injection server-side. Tokens are revoked post-task.
- **Container Hardening**: Docker containers run with `--cap-drop ALL`, `--security-opt no-new-privileges`, optional seccomp profiles, and gVisor for sandboxed code execution.

### Real-time Communication
- **SSE**: Task log streaming via `GET /api/tasks/:id/stream`.
- **WebSocket**: Live log push for clients.

### Build & Deployment
- **Development**: `npm run dev` with Vite HMR.
- **Production**: `npm run build` for client and server, then `npm start` to run.
- **DB Migrations**: Automated on server boot.

## External Dependencies

### AI Providers
- **OpenAI**: GPT models, used directly and for Ollama compatibility.
- **Anthropic**: Claude models.
- **Google Gemini**: Gemini Pro/Flash models.
- **Ollama**: Self-hosted, uses OpenAI-compatible SDK.

### Cloud Integrations
- **AWS**: SDKs for EC2, S3, STS, Lambda, CloudWatch.
- **GCP**: `@google-cloud/storage`, `googleapis`.
- **Azure**: `@azure/identity`, `@azure/arm-compute`, `@azure/arm-resources`, `@azure/arm-storage`.
- **Jira**: REST API.
- **GitHub**: REST API.
- **GitLab**: REST API.
- **RAGFlow**: REST API for knowledge base interaction.

### Database & Session
- **PostgreSQL**: Primary database.
- **`pg`**: Node.js client for PostgreSQL.
- **`drizzle-orm`**: ORM for database interactions.
- **`connect-pg-simple`**: PostgreSQL-backed session store.
- **`express-session`**: Session management middleware.

### Infrastructure
- **Docker**: For `DockerExecutor` and sandboxed code execution.
- **gVisor (`runsc`)**: Container runtime for enhanced sandboxing.
- **`node-cron`**: For scheduled job management.
- **`cron-parser`**: For parsing cron expressions.

### Communication Platforms
- **Slack**: Inbound events (HMAC verification), outbound API, Block Kit interactive approval cards, typing indicators (chat.update placeholder replacement), slash commands (/status /reset /compact /help), DM allowlist, image attachment notes.
- **Microsoft Teams**: Inbound Bot Framework events (JWT verification), outbound REST API, Adaptive Card interactive approval cards, typing activity, slash commands, DM allowlist, invoke activity handling for card button clicks.
- **Google Chat**: Full two-way support — inbound events via `/api/channels/:id/google-chat/event` (optional verification token), outbound replies via webhook URL stored in channel config. Default agent routing, configurable verification token per channel.

### Other Libraries
- **`ws`**: WebSocket server implementation.
- **`nanoid`**: For unique ID generation.
- **`zod`** + **`drizzle-zod`**: For schema validation.
- **`express-rate-limit`**: For API rate limiting.
- **`recharts`**: For frontend data visualization.
- **`openid-client`** (v6): OIDC discovery and authorization code grant flow for SSO.
- **`@node-saml/node-saml`**: SAML 2.0 SP/ACS, metadata generation, and response validation for SSO.
- **`date-fns`**: For date manipulation.

### Channel-Based Delivery
- Per-entity outbound channel selection for heartbeat monitors (`heartbeatNotifyChannelId`), scheduled jobs (`notifyChannelId`), pipelines (`notifyChannelId`), and event triggers (`notifyChannelId`).
- `dispatchToChannel(channelId, label, text)` in `server/engine/notifier.ts` — fetches channel config, selects the right adapter (Slack / Teams / Google Chat / generic webhook), and sends.
- Channel picker UI on Agents, Scheduled Jobs, Pipelines, and Triggers pages.
- Available outbound channel types: `slack`, `teams`, `google_chat`, `generic_webhook`.

### Observability Alerts
- Per-workspace token utilization threshold alert: `workspace_config.utilization_alert_threshold_tokens` + `workspace_config.utilization_alert_channel_id`.
- Checked after each task completes in the executor — fires a channel notification when the rolling token sum crosses the threshold.
- Configurable on the Observability page (alert settings card).

### Event-Driven Triggers
- Per-workspace webhook triggers that fire AI agent tasks on external events.
- Managed via `/workspaces/:wid/triggers` (TriggersPage).
- Sources: GitHub push/PR events (HMAC-SHA256 verification), GitLab push/merge events (HMAC-SHA256), Jira issue events (secret token).
- Webhook URLs: `/api/webhooks/github/:id`, `/api/webhooks/gitlab/:id`, `/api/webhooks/jira/:id?token=secret`.
- Payload templating: `{{payload.field}}` substitution in agent prompt.
- Event history logged to `trigger_events` table, viewable on the Triggers page.