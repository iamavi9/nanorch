import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import {
  users, workspaces, workspaceMembers, orchestrators, agents, channels, tasks, taskLogs, agentMemory, cloudIntegrations,
  chatConversations, chatMessages,
  type User, type InsertUser,
  type Workspace, type InsertWorkspace,
  type Orchestrator, type InsertOrchestrator,
  type Agent, type InsertAgent,
  type Channel, type InsertChannel,
  type Task, type InsertTask,
  type TaskLog,
  type AgentMemory,
  type CloudIntegration, type InsertCloudIntegration,
  type ChatConversation, type InsertChatConversation,
  type ChatMessage, type InsertChatMessage,
} from "@shared/schema";

export type WorkspaceMemberWithUser = {
  memberId: number;
  userId: string;
  username: string | null;
  name: string | null;
  email: string | null;
  role: "admin" | "member";
};

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(data: { username: string; passwordHash: string; name?: string; role?: "admin" | "member" }): Promise<User>;
  upsertUser(user: InsertUser): Promise<User>;

  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberWithUser[]>;
  addWorkspaceMember(workspaceId: string, userId: string, role: "admin" | "member"): Promise<void>;
  removeWorkspaceMember(workspaceId: string, userId: string): Promise<void>;
  isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean>;
  getUserWorkspaces(userId: string): Promise<Workspace[]>;

  getWorkspace(id: string): Promise<Workspace | undefined>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | undefined>;
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(data: InsertWorkspace): Promise<Workspace>;
  updateWorkspace(id: string, data: Partial<InsertWorkspace>): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;

  listOrchestrators(workspaceId: string): Promise<Orchestrator[]>;
  getOrchestrator(id: string): Promise<Orchestrator | undefined>;
  createOrchestrator(data: InsertOrchestrator): Promise<Orchestrator>;
  updateOrchestrator(id: string, data: Partial<InsertOrchestrator>): Promise<Orchestrator>;
  deleteOrchestrator(id: string): Promise<void>;

  listAgents(orchestratorId: string): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  createAgent(data: InsertAgent): Promise<Agent>;
  updateAgent(id: string, data: Partial<InsertAgent>): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;

  listChannels(orchestratorId: string): Promise<Channel[]>;
  getChannel(id: string): Promise<Channel | undefined>;
  getChannelByApiKey(apiKey: string): Promise<Channel | undefined>;
  createChannel(data: InsertChannel): Promise<Channel>;
  updateChannel(id: string, data: Partial<InsertChannel>): Promise<Channel>;
  deleteChannel(id: string): Promise<void>;

  listTasks(orchestratorId: string, limit?: number): Promise<Task[]>;
  listAllTasks(limit?: number): Promise<Task[]>;
  listPendingTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(data: InsertTask): Promise<Task>;
  updateTask(id: string, data: Partial<Task>): Promise<Task>;

  listTaskLogs(taskId: string): Promise<TaskLog[]>;
  createTaskLog(data: { taskId: string; level: "info" | "warn" | "error"; message: string; metadata?: Record<string, unknown> }): Promise<TaskLog>;

  getAgentMemory(agentId: string, key: string): Promise<string | null>;
  setAgentMemory(agentId: string, key: string, value: string): Promise<void>;
  listAgentMemory(agentId: string): Promise<AgentMemory[]>;

  listCloudIntegrations(workspaceId: string): Promise<CloudIntegration[]>;
  getCloudIntegration(id: string): Promise<CloudIntegration | undefined>;
  createCloudIntegration(data: InsertCloudIntegration): Promise<CloudIntegration>;
  updateCloudIntegration(id: string, data: Partial<InsertCloudIntegration>): Promise<CloudIntegration>;
  deleteCloudIntegration(id: string): Promise<void>;
  getCloudIntegrationsForWorkspace(workspaceId: string): Promise<CloudIntegration[]>;
  touchCloudIntegration(id: string): Promise<void>;

  listChatConversations(workspaceId: string): Promise<ChatConversation[]>;
  getChatConversation(id: string): Promise<ChatConversation | undefined>;
  getOrCreateDefaultConversation(workspaceId: string): Promise<ChatConversation>;
  createChatConversation(data: InsertChatConversation): Promise<ChatConversation>;
  deleteChatConversation(id: string): Promise<void>;
  listChatMessages(conversationId: string): Promise<ChatMessage[]>;
  getChatMessage(id: string): Promise<ChatMessage | undefined>;
  createChatMessage(data: InsertChatMessage): Promise<ChatMessage>;
  updateChatMessage(id: string, data: Partial<ChatMessage>): Promise<ChatMessage>;
  listAgentsForWorkspace(workspaceId: string): Promise<(Agent & { orchestratorName: string; provider: string; model: string; baseUrl: string | null })[]>;
  getWorkspaceStats(workspaceId: string): Promise<{ orchestrators: number; agents: number; completedTasks: number; failedTasks: number; runningTasks: number; pendingTasks: number }>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string) {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(data: { username: string; passwordHash: string; name?: string; role?: "admin" | "member" }) {
    const [user] = await db.insert(users).values({
      username: data.username,
      passwordHash: data.passwordHash,
      name: data.name ?? data.username,
      role: data.role ?? "member",
    }).returning();
    return user;
  }

  async upsertUser(data: InsertUser) {
    const [user] = await db.insert(users).values(data)
      .onConflictDoUpdate({ target: users.id, set: { ...data } })
      .returning();
    return user;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberWithUser[]> {
    const rows = await db
      .select({
        memberId: workspaceMembers.id,
        userId: workspaceMembers.userId,
        username: users.username,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    return rows as WorkspaceMemberWithUser[];
  }

  async addWorkspaceMember(workspaceId: string, userId: string, role: "admin" | "member") {
    await db.insert(workspaceMembers)
      .values({ workspaceId, userId, role })
      .onConflictDoNothing();
  }

  async removeWorkspaceMember(workspaceId: string, userId: string) {
    await db.delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  }

  async isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await db.select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    return !!row;
  }

  async getUserWorkspaces(userId: string): Promise<Workspace[]> {
    const rows = await db
      .select({ workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(desc(workspaces.createdAt));
    return rows.map((r) => r.workspace);
  }

  async getWorkspace(id: string) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    return ws;
  }

  async getWorkspaceBySlug(slug: string) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
    return ws;
  }

  async listWorkspaces() {
    return db.select().from(workspaces).orderBy(desc(workspaces.createdAt));
  }

  async createWorkspace(data: InsertWorkspace) {
    const [ws] = await db.insert(workspaces).values(data).returning();
    return ws;
  }

  async updateWorkspace(id: string, data: Partial<InsertWorkspace>) {
    const [ws] = await db.update(workspaces).set(data).where(eq(workspaces.id, id)).returning();
    return ws;
  }

  async deleteWorkspace(id: string) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }

  async listOrchestrators(workspaceId: string) {
    return db.select().from(orchestrators).where(eq(orchestrators.workspaceId, workspaceId)).orderBy(desc(orchestrators.createdAt));
  }

  async getOrchestrator(id: string) {
    const [orch] = await db.select().from(orchestrators).where(eq(orchestrators.id, id));
    return orch;
  }

  async createOrchestrator(data: InsertOrchestrator) {
    const [orch] = await db.insert(orchestrators).values(data).returning();
    return orch;
  }

  async updateOrchestrator(id: string, data: Partial<InsertOrchestrator>) {
    const [orch] = await db.update(orchestrators).set(data).where(eq(orchestrators.id, id)).returning();
    return orch;
  }

  async deleteOrchestrator(id: string) {
    await db.delete(orchestrators).where(eq(orchestrators.id, id));
  }

  async listAgents(orchestratorId: string) {
    return db.select().from(agents).where(eq(agents.orchestratorId, orchestratorId)).orderBy(desc(agents.createdAt));
  }

  async getAgent(id: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    return agent;
  }

  async createAgent(data: InsertAgent) {
    const [agent] = await db.insert(agents).values(data).returning();
    return agent;
  }

  async updateAgent(id: string, data: Partial<InsertAgent>) {
    const [agent] = await db.update(agents).set(data).where(eq(agents.id, id)).returning();
    return agent;
  }

  async deleteAgent(id: string) {
    await db.delete(agents).where(eq(agents.id, id));
  }

  async listChannels(orchestratorId: string) {
    return db.select().from(channels).where(eq(channels.orchestratorId, orchestratorId)).orderBy(desc(channels.createdAt));
  }

  async getChannel(id: string) {
    const [ch] = await db.select().from(channels).where(eq(channels.id, id));
    return ch;
  }

  async getChannelByApiKey(apiKey: string) {
    const [ch] = await db.select().from(channels).where(eq(channels.apiKey, apiKey));
    return ch;
  }

  async createChannel(data: InsertChannel) {
    const [ch] = await db.insert(channels).values(data).returning();
    return ch;
  }

  async updateChannel(id: string, data: Partial<InsertChannel>) {
    const [ch] = await db.update(channels).set(data).where(eq(channels.id, id)).returning();
    return ch;
  }

  async deleteChannel(id: string) {
    await db.delete(channels).where(eq(channels.id, id));
  }

  async listTasks(orchestratorId: string, limit = 50) {
    return db.select().from(tasks)
      .where(eq(tasks.orchestratorId, orchestratorId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit);
  }

  async listAllTasks(limit = 100) {
    return db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
  }

  async listPendingTasks() {
    return db.select().from(tasks).where(eq(tasks.status, "pending")).orderBy(tasks.priority, tasks.createdAt);
  }

  async getTask(id: string) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return task;
  }

  async createTask(data: InsertTask) {
    const [task] = await db.insert(tasks).values(data).returning();
    return task;
  }

  async updateTask(id: string, data: Partial<Task>) {
    const [task] = await db.update(tasks).set(data).where(eq(tasks.id, id)).returning();
    return task;
  }

  async listTaskLogs(taskId: string) {
    return db.select().from(taskLogs).where(eq(taskLogs.taskId, taskId)).orderBy(taskLogs.timestamp);
  }

  async createTaskLog(data: { taskId: string; level: "info" | "warn" | "error"; message: string; metadata?: Record<string, unknown> }) {
    const [log] = await db.insert(taskLogs).values({
      taskId: data.taskId,
      level: data.level,
      message: data.message,
      metadata: data.metadata ?? {},
    }).returning();
    return log;
  }

  async getAgentMemory(agentId: string, key: string): Promise<string | null> {
    const [mem] = await db.select().from(agentMemory)
      .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)));
    return mem?.value ?? null;
  }

  async setAgentMemory(agentId: string, key: string, value: string) {
    await db.insert(agentMemory).values({ agentId, key, value })
      .onConflictDoUpdate({ target: [agentMemory.agentId, agentMemory.key], set: { value, updatedAt: new Date() } });
  }

  async listAgentMemory(agentId: string) {
    return db.select().from(agentMemory).where(eq(agentMemory.agentId, agentId));
  }

  async listCloudIntegrations(workspaceId: string) {
    return db.select().from(cloudIntegrations)
      .where(eq(cloudIntegrations.workspaceId, workspaceId))
      .orderBy(desc(cloudIntegrations.createdAt));
  }

  async getCloudIntegration(id: string) {
    const [ci] = await db.select().from(cloudIntegrations).where(eq(cloudIntegrations.id, id));
    return ci;
  }

  async createCloudIntegration(data: InsertCloudIntegration) {
    const [ci] = await db.insert(cloudIntegrations).values(data).returning();
    return ci;
  }

  async updateCloudIntegration(id: string, data: Partial<InsertCloudIntegration>) {
    const [ci] = await db.update(cloudIntegrations).set(data).where(eq(cloudIntegrations.id, id)).returning();
    return ci;
  }

  async deleteCloudIntegration(id: string) {
    await db.delete(cloudIntegrations).where(eq(cloudIntegrations.id, id));
  }

  async getCloudIntegrationsForWorkspace(workspaceId: string) {
    return db.select().from(cloudIntegrations)
      .where(and(eq(cloudIntegrations.workspaceId, workspaceId), eq(cloudIntegrations.isActive, true)));
  }

  async touchCloudIntegration(id: string) {
    await db.update(cloudIntegrations).set({ lastUsedAt: new Date() }).where(eq(cloudIntegrations.id, id));
  }

  async listChatConversations(workspaceId: string) {
    return db.select().from(chatConversations)
      .where(eq(chatConversations.workspaceId, workspaceId))
      .orderBy(desc(chatConversations.createdAt));
  }

  async getChatConversation(id: string) {
    const [conv] = await db.select().from(chatConversations).where(eq(chatConversations.id, id));
    return conv;
  }

  async getOrCreateDefaultConversation(workspaceId: string) {
    const [existing] = await db.select().from(chatConversations)
      .where(eq(chatConversations.workspaceId, workspaceId))
      .orderBy(chatConversations.createdAt)
      .limit(1);
    if (existing) return existing;
    const [created] = await db.insert(chatConversations)
      .values({ workspaceId, title: "General" })
      .returning();
    return created;
  }

  async createChatConversation(data: InsertChatConversation) {
    const [conv] = await db.insert(chatConversations).values(data).returning();
    return conv;
  }

  async deleteChatConversation(id: string) {
    await db.delete(chatConversations).where(eq(chatConversations.id, id));
  }

  async listChatMessages(conversationId: string) {
    return db.select().from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt);
  }

  async getChatMessage(id: string) {
    const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, id));
    return msg;
  }

  async createChatMessage(data: InsertChatMessage) {
    const [msg] = await db.insert(chatMessages).values(data).returning();
    return msg;
  }

  async updateChatMessage(id: string, data: Partial<ChatMessage>) {
    const [msg] = await db.update(chatMessages).set(data).where(eq(chatMessages.id, id)).returning();
    return msg;
  }

  async listAgentsForWorkspace(workspaceId: string) {
    const rows = await db
      .select({
        id: agents.id,
        orchestratorId: agents.orchestratorId,
        name: agents.name,
        description: agents.description,
        instructions: agents.instructions,
        tools: agents.tools,
        memoryEnabled: agents.memoryEnabled,
        maxTokens: agents.maxTokens,
        temperature: agents.temperature,
        sandboxTimeoutSeconds: agents.sandboxTimeoutSeconds,
        createdAt: agents.createdAt,
        orchestratorName: orchestrators.name,
        provider: orchestrators.provider,
        model: orchestrators.model,
        baseUrl: orchestrators.baseUrl,
      })
      .from(agents)
      .innerJoin(orchestrators, eq(agents.orchestratorId, orchestrators.id))
      .where(eq(orchestrators.workspaceId, workspaceId))
      .orderBy(agents.name);
    return rows;
  }

  async getWorkspaceStats(workspaceId: string) {
    const orchRows = await db.select({ id: orchestrators.id }).from(orchestrators).where(eq(orchestrators.workspaceId, workspaceId));
    const orchIds = orchRows.map((r) => r.id);

    const agentCount = orchIds.length === 0 ? 0 :
      (await db.select({ count: sql<number>`count(*)::int` }).from(agents).where(inArray(agents.orchestratorId, orchIds)))[0]?.count ?? 0;

    if (orchIds.length === 0) {
      return { orchestrators: 0, agents: 0, completedTasks: 0, failedTasks: 0, runningTasks: 0, pendingTasks: 0 };
    }

    const taskRows = await db
      .select({ status: tasks.status, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(inArray(tasks.orchestratorId, orchIds))
      .groupBy(tasks.status);

    const counts: Record<string, number> = {};
    for (const row of taskRows) counts[row.status ?? "pending"] = row.count;

    return {
      orchestrators: orchIds.length,
      agents: agentCount,
      completedTasks: counts["completed"] ?? 0,
      failedTasks: counts["failed"] ?? 0,
      runningTasks: counts["running"] ?? 0,
      pendingTasks: counts["pending"] ?? 0,
    };
  }
}

export const storage = new DatabaseStorage();
