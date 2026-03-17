import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Bot, Trash2, Edit, Brain, Thermometer, Wrench, ChevronDown, ChevronRight, Database, Cloud, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Agent, CloudIntegration } from "@shared/schema";

interface Props {
  orchestratorId: string;
  workspaceId: string;
}

interface AgentForm {
  name: string;
  description: string;
  instructions: string;
  maxTokens: number;
  temperature: number;
  memoryEnabled: boolean;
  tools: string[];
  sandboxTimeoutSeconds: number | null;
}

const defaultForm: AgentForm = {
  name: "",
  description: "",
  instructions: "",
  maxTokens: 4096,
  temperature: 70,
  memoryEnabled: false,
  tools: [],
  sandboxTimeoutSeconds: null,
};

const PROVIDER_TOOLS: Record<string, { name: string; label: string; description: string }[]> = {
  ragflow: [
    { name: "ragflow_list_datasets", label: "List Datasets", description: "List all knowledge base datasets" },
    { name: "ragflow_query_dataset", label: "Query Dataset", description: "Query a single dataset with a question" },
    { name: "ragflow_query_multiple_datasets", label: "Query Multiple Datasets", description: "Query across multiple datasets at once" },
  ],
  aws: [
    { name: "aws_list_s3_buckets", label: "List S3 Buckets", description: "List all S3 buckets" },
    { name: "aws_list_s3_objects", label: "List S3 Objects", description: "List objects in an S3 bucket" },
    { name: "aws_list_ec2_instances", label: "List EC2 Instances", description: "List EC2 instances" },
    { name: "aws_list_lambda_functions", label: "List Lambda Functions", description: "List Lambda functions" },
    { name: "aws_get_cloudwatch_logs", label: "Get CloudWatch Logs", description: "Fetch CloudWatch log events" },
  ],
  gcp: [
    { name: "gcp_list_storage_buckets", label: "List Storage Buckets", description: "List GCS buckets" },
    { name: "gcp_list_compute_instances", label: "List Compute Instances", description: "List GCE instances" },
    { name: "gcp_list_cloud_functions", label: "List Cloud Functions", description: "List Cloud Functions" },
  ],
  azure: [
    { name: "azure_list_resource_groups", label: "List Resource Groups", description: "List Azure resource groups" },
    { name: "azure_list_virtual_machines", label: "List Virtual Machines", description: "List Azure VMs" },
    { name: "azure_list_storage_accounts", label: "List Storage Accounts", description: "List Azure storage accounts" },
  ],
};

const PROVIDER_ICONS: Record<string, { icon: any; color: string; bg: string }> = {
  ragflow: { icon: Database, color: "text-violet-400", bg: "bg-violet-500/10" },
  aws: { icon: Cloud, color: "text-orange-400", bg: "bg-orange-500/10" },
  gcp: { icon: Cloud, color: "text-blue-400", bg: "bg-blue-500/10" },
  azure: { icon: Cloud, color: "text-sky-400", bg: "bg-sky-500/10" },
};

function ToolsPicker({ workspaceId, selected, onChange }: {
  workspaceId: string;
  selected: string[];
  onChange: (tools: string[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data: integrations = [], isLoading } = useQuery<CloudIntegration[]>({
    queryKey: [`/api/workspaces/${workspaceId}/integrations`],
  });

  const toggle = (toolName: string) => {
    onChange(selected.includes(toolName)
      ? selected.filter((t) => t !== toolName)
      : [...selected, toolName]);
  };

  const toggleExpand = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  if (isLoading) return <Skeleton className="h-16 w-full" />;

  if (integrations.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        No cloud integrations configured.{" "}
        <a href={`/workspaces/${workspaceId}/integrations`} className="underline text-primary hover:text-primary/80">
          Add one on the Integrations page.
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {integrations.map((ci) => {
        const tools = PROVIDER_TOOLS[ci.provider] ?? [];
        if (tools.length === 0) return null;
        const isOpen = expanded[ci.id] ?? true;
        const providerMeta = PROVIDER_ICONS[ci.provider] ?? { icon: Cloud, color: "text-muted-foreground", bg: "bg-muted" };
        const Icon = providerMeta.icon;
        const enabledCount = tools.filter((t) => selected.includes(t.name)).length;

        return (
          <div key={ci.id} className="rounded-md border">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/40 transition-colors text-left"
              onClick={() => toggleExpand(ci.id)}
              data-testid={`expand-tools-${ci.id}`}
            >
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded flex items-center justify-center ${providerMeta.bg}`}>
                  <Icon className={`w-3.5 h-3.5 ${providerMeta.color}`} />
                </div>
                <span className="text-sm font-medium">{ci.name}</span>
                <Badge variant="outline" className="text-xs capitalize px-1.5 py-0">{ci.provider}</Badge>
              </div>
              <div className="flex items-center gap-2">
                {enabledCount > 0 && (
                  <Badge className="text-xs bg-primary/20 text-primary border-primary/30 px-1.5 py-0">
                    {enabledCount}/{tools.length}
                  </Badge>
                )}
                {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              </div>
            </button>

            {isOpen && (
              <div className="border-t px-3 py-2 space-y-2">
                {tools.map((tool) => (
                  <div key={tool.name} className="flex items-start gap-2.5 py-1">
                    <Checkbox
                      id={`tool-${tool.name}`}
                      checked={selected.includes(tool.name)}
                      onCheckedChange={() => toggle(tool.name)}
                      data-testid={`checkbox-tool-${tool.name}`}
                    />
                    <label htmlFor={`tool-${tool.name}`} className="cursor-pointer flex-1 min-w-0">
                      <div className="text-sm font-medium leading-none">{tool.label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{tool.description}</div>
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AgentsPage({ orchestratorId, workspaceId }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [form, setForm] = useState<AgentForm>(defaultForm);

  const { data: agents, isLoading } = useQuery<Agent[]>({
    queryKey: [`/api/orchestrators/${orchestratorId}/agents`],
  });

  const createMutation = useMutation({
    mutationFn: (data: AgentForm) => apiRequest("POST", `/api/orchestrators/${orchestratorId}/agents`, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/api/orchestrators/${orchestratorId}/agents`] });
      setOpen(false);
      setForm(defaultForm);
      toast({ title: "Agent created" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: AgentForm }) => apiRequest("PUT", `/api/agents/${id}`, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/api/orchestrators/${orchestratorId}/agents`] });
      setEditAgent(null);
      setOpen(false);
      toast({ title: "Agent updated" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/agents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/orchestrators/${orchestratorId}/agents`] }),
  });

  const openCreate = () => {
    setEditAgent(null);
    setForm(defaultForm);
    setOpen(true);
  };

  const openEdit = (agent: Agent) => {
    setEditAgent(agent);
    setForm({
      name: agent.name,
      description: agent.description ?? "",
      instructions: agent.instructions ?? "",
      maxTokens: agent.maxTokens ?? 4096,
      temperature: agent.temperature ?? 70,
      memoryEnabled: agent.memoryEnabled ?? false,
      tools: Array.isArray(agent.tools) ? (agent.tools as string[]) : [],
      sandboxTimeoutSeconds: agent.sandboxTimeoutSeconds ?? null,
    });
    setOpen(true);
  };

  const handleSubmit = () => {
    if (editAgent) {
      updateMutation.mutate({ id: editAgent.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground mt-1">AI agents within this orchestrator</p>
        </div>
        <Button onClick={openCreate} data-testid="button-new-agent">
          <Plus className="w-4 h-4 mr-2" /> New Agent
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : agents?.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <Bot className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
            <h3 className="font-semibold mb-2">No agents yet</h3>
            <p className="text-muted-foreground mb-4">Create your first agent for this orchestrator</p>
            <Button onClick={openCreate} data-testid="button-create-first-agent">
              <Plus className="w-4 h-4 mr-2" /> Create Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents?.map((agent) => {
            const toolCount = Array.isArray(agent.tools) ? (agent.tools as string[]).length : 0;
            return (
              <Card key={agent.id} className="group" data-testid={`card-agent-${agent.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center mb-2">
                      <Bot className="w-5 h-5 text-violet-400" />
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(agent)}
                        data-testid={`button-edit-agent-${agent.id}`}>
                        <Edit className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteMutation.mutate(agent.id)}
                        data-testid={`button-delete-agent-${agent.id}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <CardTitle className="text-base">{agent.name}</CardTitle>
                  {agent.description && <p className="text-xs text-muted-foreground">{agent.description}</p>}
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary" className="text-xs gap-1">
                      <Thermometer className="w-3 h-3" /> {(agent.temperature ?? 70) / 100}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">{agent.maxTokens ?? 4096} tokens</Badge>
                    {agent.memoryEnabled && (
                      <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30 gap-1">
                        <Brain className="w-3 h-3" /> Memory
                      </Badge>
                    )}
                    {toolCount > 0 && (
                      <Badge className="text-xs bg-violet-500/20 text-violet-400 border-violet-500/30 gap-1"
                        data-testid={`badge-tools-${agent.id}`}>
                        <Wrench className="w-3 h-3" /> {toolCount} tool{toolCount !== 1 ? "s" : ""}
                      </Badge>
                    )}
                    {agent.sandboxTimeoutSeconds != null && (
                      <Badge variant="secondary" className="text-xs gap-1"
                        data-testid={`badge-timeout-${agent.id}`}>
                        <Timer className="w-3 h-3" /> {agent.sandboxTimeoutSeconds}s
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editAgent ? "Edit Agent" : "Create Agent"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Research Agent" className="mt-1" data-testid="input-agent-name" />
            </div>
            <div>
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional description" className="mt-1" />
            </div>
            <div>
              <Label>Instructions</Label>
              <Textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                placeholder="You are a research agent specialized in..." className="mt-1 font-mono text-sm" rows={4}
                data-testid="input-agent-instructions" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs">Temperature: {(form.temperature / 100).toFixed(2)}</Label>
                <Slider min={0} max={100} step={5} value={[form.temperature]}
                  onValueChange={([v]) => setForm({ ...form, temperature: v })} className="mt-2" />
              </div>
              <div>
                <Label className="text-xs">Max Tokens</Label>
                <Input type="number" value={form.maxTokens} className="mt-1"
                  onChange={(e) => setForm({ ...form, maxTokens: parseInt(e.target.value) || 4096 })} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={form.memoryEnabled} onCheckedChange={(v) => setForm({ ...form, memoryEnabled: v })}
                id="memory-switch" data-testid="switch-memory" />
              <Label htmlFor="memory-switch" className="cursor-pointer">
                <span className="flex items-center gap-1.5"><Brain className="w-4 h-4" /> Enable Memory</span>
                <span className="text-xs text-muted-foreground">Agent retains context between tasks</span>
              </Label>
            </div>
            <div>
              <Label className="flex items-center gap-1.5 text-xs">
                <Timer className="w-3.5 h-3.5" /> Code Execution Timeout (seconds)
              </Label>
              <div className="flex items-center gap-2 mt-1">
                <Input
                  type="number"
                  min={5}
                  max={300}
                  placeholder="Default (30s)"
                  value={form.sandboxTimeoutSeconds ?? ""}
                  onChange={(e) => {
                    const val = e.target.value === "" ? null : Math.min(300, Math.max(5, parseInt(e.target.value) || 5));
                    setForm({ ...form, sandboxTimeoutSeconds: val });
                  }}
                  className="w-40"
                  data-testid="input-sandbox-timeout"
                />
                {form.sandboxTimeoutSeconds != null && (
                  <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground"
                    onClick={() => setForm({ ...form, sandboxTimeoutSeconds: null })}>
                    Reset to default
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                How long the sandbox can run before being killed. Min 5s, max 300s. Leave blank to use the system default (30s).
              </p>
            </div>
            <div>
              <Label className="flex items-center gap-1.5 mb-2">
                <Wrench className="w-4 h-4" /> Tools
              </Label>
              <ToolsPicker
                workspaceId={workspaceId}
                selected={form.tools}
                onChange={(tools) => setForm({ ...form, tools })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending || !form.name}
              data-testid="button-submit-agent">
              {createMutation.isPending || updateMutation.isPending ? "Saving..." : editAgent ? "Update Agent" : "Create Agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
