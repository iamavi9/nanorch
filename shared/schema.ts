import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb, serial, pgEnum, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const userRoleEnum = pgEnum("user_role", ["admin", "member"]);
export const providerEnum = pgEnum("provider", ["openai", "anthropic", "gemini", "ollama"]);
export const orchestratorStatusEnum = pgEnum("orchestrator_status", ["active", "paused"]);
export const taskStatusEnum = pgEnum("task_status", ["pending", "running", "completed", "failed"]);
export const channelTypeEnum = pgEnum("channel_type", ["webhook", "api"]);
export const logLevelEnum = pgEnum("log_level", ["info", "warn", "error"]);
export const cloudProviderEnum = pgEnum("cloud_provider", ["aws", "gcp", "azure", "ragflow"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: varchar("username").unique(),
  passwordHash: text("password_hash"),
  email: varchar("email").unique(),
  name: text("name"),
  role: userRoleEnum("role").default("member"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: varchar("slug").notNull().unique(),
  description: text("description"),
  ownerId: varchar("owner_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const workspaceMembers = pgTable("workspace_members", {
  id: serial("id").primaryKey(),
  workspaceId: varchar("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: userRoleEnum("role").default("member"),
}, (t) => [unique().on(t.workspaceId, t.userId)]);

export const orchestrators = pgTable("orchestrators", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: varchar("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  provider: providerEnum("provider").notNull().default("openai"),
  model: varchar("model").notNull().default("gpt-4o"),
  baseUrl: text("base_url"),
  systemPrompt: text("system_prompt"),
  maxConcurrency: integer("max_concurrency").default(3),
  maxRetries: integer("max_retries").default(2),
  timeoutSeconds: integer("timeout_seconds").default(120),
  status: orchestratorStatusEnum("status").default("active"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orchestratorId: varchar("orchestrator_id").notNull().references(() => orchestrators.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  instructions: text("instructions"),
  tools: jsonb("tools").default([]),
  memoryEnabled: boolean("memory_enabled").default(false),
  maxTokens: integer("max_tokens").default(4096),
  temperature: integer("temperature").default(70),
  sandboxTimeoutSeconds: integer("sandbox_timeout_seconds"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const channels = pgTable("channels", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orchestratorId: varchar("orchestrator_id").notNull().references(() => orchestrators.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: channelTypeEnum("type").notNull().default("api"),
  config: jsonb("config").default({}),
  apiKey: varchar("api_key").default(sql`gen_random_uuid()`),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orchestratorId: varchar("orchestrator_id").notNull().references(() => orchestrators.id, { onDelete: "cascade" }),
  agentId: varchar("agent_id").references(() => agents.id),
  channelId: varchar("channel_id").references(() => channels.id),
  input: text("input").notNull(),
  output: text("output"),
  status: taskStatusEnum("status").default("pending"),
  priority: integer("priority").default(5),
  intent: varchar("intent"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

export const taskLogs = pgTable("task_logs", {
  id: serial("id").primaryKey(),
  taskId: varchar("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  level: logLevelEnum("level").default("info"),
  message: text("message").notNull(),
  metadata: jsonb("metadata").default({}),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const agentMemory = pgTable("agent_memory", {
  id: serial("id").primaryKey(),
  agentId: varchar("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  key: varchar("key").notNull(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [unique("agent_memory_agent_key").on(t.agentId, t.key)]);

export const cloudIntegrations = pgTable("cloud_integrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: varchar("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  provider: cloudProviderEnum("provider").notNull(),
  integrationMode: text("integration_mode").default("tool").notNull(),
  credentialsEncrypted: text("credentials_encrypted").notNull(),
  scopes: text("scopes").array().default([]),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
});

export const chatConversations = pgTable("chat_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: varchar("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Chat"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  agentId: varchar("agent_id").references(() => agents.id, { onDelete: "set null" }),
  agentName: text("agent_name"),
  content: text("content").notNull(),
  mentions: text("mentions").array().default([]),
  messageType: text("message_type").notNull().default("text"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertWorkspaceSchema = createInsertSchema(workspaces).omit({ id: true, createdAt: true });
export const insertOrchestratorSchema = createInsertSchema(orchestrators).omit({ id: true, createdAt: true });
export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true });
export const insertChannelSchema = createInsertSchema(channels).omit({ id: true, createdAt: true });
export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true, createdAt: true, startedAt: true, completedAt: true });
export const insertTaskLogSchema = createInsertSchema(taskLogs).omit({ id: true, timestamp: true });

export const insertCloudIntegrationSchema = createInsertSchema(cloudIntegrations).omit({ id: true, createdAt: true, lastUsedAt: true });

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Workspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = z.infer<typeof insertWorkspaceSchema>;
export type Orchestrator = typeof orchestrators.$inferSelect;
export type InsertOrchestrator = z.infer<typeof insertOrchestratorSchema>;
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Channel = typeof channels.$inferSelect;
export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type TaskLog = typeof taskLogs.$inferSelect;
export type AgentMemory = typeof agentMemory.$inferSelect;
export type CloudIntegration = typeof cloudIntegrations.$inferSelect;
export type InsertCloudIntegration = z.infer<typeof insertCloudIntegrationSchema>;

export const insertChatConversationSchema = createInsertSchema(chatConversations).omit({ id: true, createdAt: true });
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true, createdAt: true });
export type ChatConversation = typeof chatConversations.$inferSelect;
export type InsertChatConversation = z.infer<typeof insertChatConversationSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
