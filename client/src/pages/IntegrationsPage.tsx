import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2, CheckCircle2, XCircle, Loader2, RefreshCw, Plug, ShieldCheck, AlertTriangle, CloudCog, Database, Wrench, BookOpen, Pencil } from "lucide-react";
import { SiAmazon, SiGooglecloud } from "react-icons/si";
import type { CloudIntegration } from "@shared/schema";

interface Props { workspaceId: string; }

const PROVIDER_META = {
  aws: { label: "AWS", icon: SiAmazon, color: "text-orange-500", bg: "bg-orange-500/10" },
  gcp: { label: "Google Cloud", icon: SiGooglecloud, color: "text-blue-500", bg: "bg-blue-500/10" },
  azure: { label: "Azure", icon: CloudCog, color: "text-sky-500", bg: "bg-sky-500/10" },
  ragflow: { label: "RAGFlow", icon: Database, color: "text-violet-500", bg: "bg-violet-500/10" },
};

type SafeIntegration = Omit<CloudIntegration, "credentialsEncrypted">;

function ModeSelector({ value, onChange }: { value: "tool" | "context"; onChange: (v: "tool" | "context") => void }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Integration Mode</Label>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange("tool")}
          className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
            value === "tool"
              ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400"
              : "border-border bg-muted/30 hover:bg-muted/60 text-muted-foreground"
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <Wrench className="w-3.5 h-3.5" /> Tool
          </div>
          <p className="text-xs opacity-80">Agent explicitly calls this integration as a tool during tasks</p>
        </button>
        <button
          type="button"
          onClick={() => onChange("context")}
          className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
            value === "context"
              ? "border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-400"
              : "border-border bg-muted/30 hover:bg-muted/60 text-muted-foreground"
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <BookOpen className="w-3.5 h-3.5" /> Context
          </div>
          <p className="text-xs opacity-80">Knowledge is auto-retrieved and injected before every AI response</p>
        </button>
      </div>
    </div>
  );
}

export default function IntegrationsPage({ workspaceId }: Props) {
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"aws" | "gcp" | "azure" | "ragflow">("aws");
  const [mode, setMode] = useState<"tool" | "context">("tool");
  const [awsForm, setAwsForm] = useState({ name: "", accessKeyId: "", secretAccessKey: "", region: "us-east-1" });
  const [gcpForm, setGcpForm] = useState({ name: "", serviceAccountJson: "" });
  const [azureForm, setAzureForm] = useState({ name: "", clientId: "", clientSecret: "", tenantId: "", subscriptionId: "" });
  const [ragflowForm, setRagflowForm] = useState({ name: "", baseUrl: "", apiKey: "" });

  const [editingIntegration, setEditingIntegration] = useState<SafeIntegration | null>(null);
  const [editName, setEditName] = useState("");
  const [editMode, setEditMode] = useState<"tool" | "context">("tool");
  const [editAwsCreds, setEditAwsCreds] = useState({ accessKeyId: "", secretAccessKey: "", region: "" });
  const [editGcpJson, setEditGcpJson] = useState("");
  const [editAzureCreds, setEditAzureCreds] = useState({ clientId: "", clientSecret: "", tenantId: "", subscriptionId: "" });
  const [editRagflowCreds, setEditRagflowCreds] = useState({ baseUrl: "", apiKey: "" });

  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string } | "loading">>({});

  const { data: integrations = [], isLoading } = useQuery<SafeIntegration[]>({
    queryKey: [`/api/workspaces/${workspaceId}/integrations`],
  });

  const createMutation = useMutation({
    mutationFn: async (body: { name: string; provider: string; credentials: unknown; integrationMode: string }) =>
      apiRequest("POST", `/api/workspaces/${workspaceId}/integrations`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/workspaces/${workspaceId}/integrations`] });
      setOpen(false);
      resetForms();
      toast({ title: "Integration added", description: "Credentials saved and encrypted." });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiRequest("PUT", `/api/integrations/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/workspaces/${workspaceId}/integrations`] });
      setEditingIntegration(null);
      toast({ title: "Integration updated" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/integrations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/workspaces/${workspaceId}/integrations`] });
      toast({ title: "Integration removed" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiRequest("PUT", `/api/integrations/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/workspaces/${workspaceId}/integrations`] }),
  });

  const resetForms = () => {
    setAwsForm({ name: "", accessKeyId: "", secretAccessKey: "", region: "us-east-1" });
    setGcpForm({ name: "", serviceAccountJson: "" });
    setAzureForm({ name: "", clientId: "", clientSecret: "", tenantId: "", subscriptionId: "" });
    setRagflowForm({ name: "", baseUrl: "", apiKey: "" });
    setTab("aws");
    setMode("tool");
  };

  const handleTabChange = (v: string) => {
    setTab(v as any);
    setMode(v === "ragflow" ? "context" : "tool");
  };

  const openEdit = (ci: SafeIntegration) => {
    setEditingIntegration(ci);
    setEditName(ci.name);
    setEditMode((ci.integrationMode as "tool" | "context") ?? "tool");
    setEditAwsCreds({ accessKeyId: "", secretAccessKey: "", region: "" });
    setEditGcpJson("");
    setEditAzureCreds({ clientId: "", clientSecret: "", tenantId: "", subscriptionId: "" });
    setEditRagflowCreds({ baseUrl: "", apiKey: "" });
  };

  const handleEdit = () => {
    if (!editingIntegration) return;
    if (!editName.trim()) {
      toast({ title: "Name is required", variant: "destructive" }); return;
    }
    const body: Record<string, unknown> = { name: editName.trim(), integrationMode: editMode };
    const p = editingIntegration.provider;
    if (p === "aws" && (editAwsCreds.accessKeyId || editAwsCreds.secretAccessKey)) {
      body.credentials = { accessKeyId: editAwsCreds.accessKeyId, secretAccessKey: editAwsCreds.secretAccessKey, region: editAwsCreds.region || "us-east-1" };
    } else if (p === "gcp" && editGcpJson.trim()) {
      try { body.credentials = JSON.parse(editGcpJson); }
      catch { toast({ title: "Invalid JSON", variant: "destructive" }); return; }
    } else if (p === "azure" && (editAzureCreds.clientId || editAzureCreds.clientSecret)) {
      body.credentials = editAzureCreds;
    } else if (p === "ragflow" && (editRagflowCreds.baseUrl || editRagflowCreds.apiKey)) {
      body.credentials = editRagflowCreds;
    }
    editMutation.mutate({ id: editingIntegration.id, body });
  };

  const handleCreate = () => {
    if (tab === "aws") {
      if (!awsForm.name || !awsForm.accessKeyId || !awsForm.secretAccessKey) {
        toast({ title: "Required fields missing", variant: "destructive" }); return;
      }
      createMutation.mutate({ name: awsForm.name, provider: "aws", integrationMode: mode, credentials: { accessKeyId: awsForm.accessKeyId, secretAccessKey: awsForm.secretAccessKey, region: awsForm.region } });
    } else if (tab === "gcp") {
      if (!gcpForm.name || !gcpForm.serviceAccountJson) {
        toast({ title: "Required fields missing", variant: "destructive" }); return;
      }
      try {
        const parsed = JSON.parse(gcpForm.serviceAccountJson);
        createMutation.mutate({ name: gcpForm.name, provider: "gcp", integrationMode: mode, credentials: parsed });
      } catch {
        toast({ title: "Invalid JSON", description: "Service account key must be valid JSON", variant: "destructive" }); return;
      }
    } else if (tab === "azure") {
      if (!azureForm.name || !azureForm.clientId || !azureForm.clientSecret || !azureForm.tenantId || !azureForm.subscriptionId) {
        toast({ title: "Required fields missing", variant: "destructive" }); return;
      }
      createMutation.mutate({ name: azureForm.name, provider: "azure", integrationMode: mode, credentials: { clientId: azureForm.clientId, clientSecret: azureForm.clientSecret, tenantId: azureForm.tenantId, subscriptionId: azureForm.subscriptionId } });
    } else {
      if (!ragflowForm.name || !ragflowForm.baseUrl || !ragflowForm.apiKey) {
        toast({ title: "Required fields missing", variant: "destructive" }); return;
      }
      createMutation.mutate({ name: ragflowForm.name, provider: "ragflow", integrationMode: mode, credentials: { baseUrl: ragflowForm.baseUrl, apiKey: ragflowForm.apiKey } });
    }
  };

  const handleTest = async (id: string) => {
    setTestResults((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const res = await fetch(`/api/integrations/${id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [id]: data }));
    } catch (err: any) {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, detail: err.message } }));
    }
  };

  const toolIntegrations = integrations.filter((i) => i.integrationMode !== "context");
  const contextIntegrations = integrations.filter((i) => i.integrationMode === "context");

  const renderCard = (ci: SafeIntegration) => {
    const meta = PROVIDER_META[ci.provider as keyof typeof PROVIDER_META];
    const ProviderIcon = meta.icon;
    const testResult = testResults[ci.id];
    const isContext = ci.integrationMode === "context";
    return (
      <Card key={ci.id} data-testid={`card-integration-${ci.id}`} className={!ci.isActive ? "opacity-60" : ""}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg ${meta.bg} flex items-center justify-center`}>
                <ProviderIcon className={`w-5 h-5 ${meta.color}`} />
              </div>
              <div>
                <CardTitle className="text-base">{ci.name}</CardTitle>
                <CardDescription className="text-xs">{meta.label}</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                data-testid={`mode-badge-${ci.id}`}
                className={isContext
                  ? "border-violet-500/40 text-violet-500 bg-violet-500/10 gap-1"
                  : "border-blue-500/40 text-blue-500 bg-blue-500/10 gap-1"}
              >
                {isContext ? <BookOpen className="w-3 h-3" /> : <Wrench className="w-3 h-3" />}
                {isContext ? "Context" : "Tool"}
              </Badge>
              <Badge variant={ci.isActive ? "default" : "secondary"} data-testid={`status-integration-${ci.id}`}>
                {ci.isActive ? "Active" : "Inactive"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {ci.lastUsedAt ? (
              <span className="text-xs text-muted-foreground">Last used: {new Date(ci.lastUsedAt).toLocaleString()}</span>
            ) : (
              <span className="text-xs text-muted-foreground">Never used</span>
            )}
            <div className="flex-1" />
            <Button variant="outline" size="sm" data-testid={`button-test-${ci.id}`} onClick={() => handleTest(ci.id)} disabled={testResult === "loading"}>
              {testResult === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Test
            </Button>
            <Button variant="outline" size="sm" data-testid={`button-edit-${ci.id}`} onClick={() => openEdit(ci)}>
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
            </Button>
            <Button variant="outline" size="sm" data-testid={`button-toggle-${ci.id}`} onClick={() => toggleMutation.mutate({ id: ci.id, isActive: !ci.isActive })}>
              {ci.isActive ? "Disable" : "Enable"}
            </Button>
            <Button variant="ghost" size="sm" data-testid={`button-delete-${ci.id}`} className="text-destructive hover:text-destructive" onClick={() => deleteMutation.mutate(ci.id)}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
          {testResult && testResult !== "loading" && (
            <div className={`mt-3 flex items-start gap-2 text-sm p-2 rounded-md ${testResult.ok ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-destructive/10 text-destructive"}`}>
              {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{testResult.detail}</span>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Plug className="w-6 h-6 text-primary" />
            Integrations
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Connect AWS, GCP, Azure, and RAGFlow. Credentials are encrypted at rest with AES-256-GCM.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-integration">
              <Plus className="w-4 h-4 mr-2" />
              Add Integration
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Integration</DialogTitle>
            </DialogHeader>

            <Tabs value={tab} onValueChange={handleTabChange}>
              <TabsList className="w-full">
                <TabsTrigger value="aws" className="flex-1 gap-1.5" data-testid="tab-aws">
                  <SiAmazon className="w-3.5 h-3.5" /> AWS
                </TabsTrigger>
                <TabsTrigger value="gcp" className="flex-1 gap-1.5" data-testid="tab-gcp">
                  <SiGooglecloud className="w-3.5 h-3.5" /> GCP
                </TabsTrigger>
                <TabsTrigger value="azure" className="flex-1 gap-1.5" data-testid="tab-azure">
                  <CloudCog className="w-3.5 h-3.5" /> Azure
                </TabsTrigger>
                <TabsTrigger value="ragflow" className="flex-1 gap-1.5" data-testid="tab-ragflow">
                  <Database className="w-3.5 h-3.5" /> RAGFlow
                </TabsTrigger>
              </TabsList>

              <TabsContent value="aws" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Integration Name</Label>
                  <Input data-testid="input-aws-name" placeholder="My AWS Account" value={awsForm.name} onChange={(e) => setAwsForm({ ...awsForm, name: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Access Key ID</Label>
                  <Input data-testid="input-aws-key-id" placeholder="AKIAIOSFODNN7EXAMPLE" value={awsForm.accessKeyId} onChange={(e) => setAwsForm({ ...awsForm, accessKeyId: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Secret Access Key</Label>
                  <Input data-testid="input-aws-secret" type="password" placeholder="••••••••••••••••••••••••••••••••••••••••" value={awsForm.secretAccessKey} onChange={(e) => setAwsForm({ ...awsForm, secretAccessKey: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Default Region</Label>
                  <Input data-testid="input-aws-region" placeholder="us-east-1" value={awsForm.region} onChange={(e) => setAwsForm({ ...awsForm, region: e.target.value })} />
                </div>
              </TabsContent>

              <TabsContent value="gcp" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Integration Name</Label>
                  <Input data-testid="input-gcp-name" placeholder="My GCP Project" value={gcpForm.name} onChange={(e) => setGcpForm({ ...gcpForm, name: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Service Account JSON</Label>
                  <Textarea data-testid="input-gcp-json" placeholder='{"type": "service_account", "project_id": "...", ...}' className="font-mono text-xs h-48 resize-none" value={gcpForm.serviceAccountJson} onChange={(e) => setGcpForm({ ...gcpForm, serviceAccountJson: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Paste the full JSON key file from Google Cloud Console → IAM → Service Accounts</p>
                </div>
              </TabsContent>

              <TabsContent value="azure" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Integration Name</Label>
                  <Input data-testid="input-azure-name" placeholder="My Azure Subscription" value={azureForm.name} onChange={(e) => setAzureForm({ ...azureForm, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Client ID</Label>
                    <Input data-testid="input-azure-client-id" placeholder="xxxxxxxx-xxxx-..." value={azureForm.clientId} onChange={(e) => setAzureForm({ ...azureForm, clientId: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Client Secret</Label>
                    <Input data-testid="input-azure-client-secret" type="password" placeholder="••••••••" value={azureForm.clientSecret} onChange={(e) => setAzureForm({ ...azureForm, clientSecret: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Tenant ID</Label>
                    <Input data-testid="input-azure-tenant-id" placeholder="xxxxxxxx-xxxx-..." value={azureForm.tenantId} onChange={(e) => setAzureForm({ ...azureForm, tenantId: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Subscription ID</Label>
                    <Input data-testid="input-azure-subscription-id" placeholder="xxxxxxxx-xxxx-..." value={azureForm.subscriptionId} onChange={(e) => setAzureForm({ ...azureForm, subscriptionId: e.target.value })} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="ragflow" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Integration Name</Label>
                  <Input data-testid="input-ragflow-name" placeholder="Company Knowledge Base" value={ragflowForm.name} onChange={(e) => setRagflowForm({ ...ragflowForm, name: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>RAGFlow Base URL</Label>
                  <Input data-testid="input-ragflow-url" placeholder="http://ragflow.example.com" value={ragflowForm.baseUrl} onChange={(e) => setRagflowForm({ ...ragflowForm, baseUrl: e.target.value })} />
                  <p className="text-xs text-muted-foreground">The URL where your RAGFlow instance is running (no trailing slash)</p>
                </div>
                <div className="space-y-2">
                  <Label>API Key</Label>
                  <Input data-testid="input-ragflow-key" type="password" placeholder="ragflow-api-key" value={ragflowForm.apiKey} onChange={(e) => setRagflowForm({ ...ragflowForm, apiKey: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Found in RAGFlow → Profile → API Keys</p>
                </div>
              </TabsContent>
            </Tabs>

            <ModeSelector value={mode} onChange={setMode} />

            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground bg-muted/50 rounded-md p-2">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-green-500" />
              Credentials are encrypted with AES-256-GCM before storage. Raw credentials are never logged.
            </div>

            <div className="flex justify-end gap-2 mt-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button data-testid="button-save-integration" onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Save Integration
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editingIntegration} onOpenChange={(o) => { if (!o) setEditingIntegration(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Integration</DialogTitle>
          </DialogHeader>
          {editingIntegration && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input data-testid="input-edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>

              <ModeSelector value={editMode} onChange={setEditMode} />

              <div className="space-y-2">
                <Label className="text-sm font-medium">Update Credentials <span className="text-muted-foreground font-normal">(leave blank to keep existing)</span></Label>
                {editingIntegration.provider === "aws" && (
                  <div className="space-y-2">
                    <Input data-testid="input-edit-aws-key-id" placeholder="Access Key ID" value={editAwsCreds.accessKeyId} onChange={(e) => setEditAwsCreds({ ...editAwsCreds, accessKeyId: e.target.value })} />
                    <Input data-testid="input-edit-aws-secret" type="password" placeholder="Secret Access Key" value={editAwsCreds.secretAccessKey} onChange={(e) => setEditAwsCreds({ ...editAwsCreds, secretAccessKey: e.target.value })} />
                    <Input data-testid="input-edit-aws-region" placeholder="Region (e.g. us-east-1)" value={editAwsCreds.region} onChange={(e) => setEditAwsCreds({ ...editAwsCreds, region: e.target.value })} />
                  </div>
                )}
                {editingIntegration.provider === "gcp" && (
                  <Textarea data-testid="input-edit-gcp-json" placeholder='{"type": "service_account", ...}' className="font-mono text-xs h-32 resize-none" value={editGcpJson} onChange={(e) => setEditGcpJson(e.target.value)} />
                )}
                {editingIntegration.provider === "azure" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input data-testid="input-edit-azure-client-id" placeholder="Client ID" value={editAzureCreds.clientId} onChange={(e) => setEditAzureCreds({ ...editAzureCreds, clientId: e.target.value })} />
                    <Input data-testid="input-edit-azure-client-secret" type="password" placeholder="Client Secret" value={editAzureCreds.clientSecret} onChange={(e) => setEditAzureCreds({ ...editAzureCreds, clientSecret: e.target.value })} />
                    <Input data-testid="input-edit-azure-tenant-id" placeholder="Tenant ID" value={editAzureCreds.tenantId} onChange={(e) => setEditAzureCreds({ ...editAzureCreds, tenantId: e.target.value })} />
                    <Input data-testid="input-edit-azure-sub-id" placeholder="Subscription ID" value={editAzureCreds.subscriptionId} onChange={(e) => setEditAzureCreds({ ...editAzureCreds, subscriptionId: e.target.value })} />
                  </div>
                )}
                {editingIntegration.provider === "ragflow" && (
                  <div className="space-y-2">
                    <Input data-testid="input-edit-ragflow-url" placeholder="RAGFlow Base URL" value={editRagflowCreds.baseUrl} onChange={(e) => setEditRagflowCreds({ ...editRagflowCreds, baseUrl: e.target.value })} />
                    <Input data-testid="input-edit-ragflow-key" type="password" placeholder="API Key" value={editRagflowCreds.apiKey} onChange={(e) => setEditRagflowCreds({ ...editRagflowCreds, apiKey: e.target.value })} />
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingIntegration(null)}>Cancel</Button>
                <Button data-testid="button-save-edit" onClick={handleEdit} disabled={editMutation.isPending}>
                  {editMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Save Changes
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading integrations...
        </div>
      ) : integrations.length === 0 ? (
        <div className="border-2 border-dashed rounded-xl p-12 text-center">
          <Plug className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
          <p className="font-medium text-muted-foreground">No integrations yet</p>
          <p className="text-sm text-muted-foreground/60 mt-1 mb-4">Add AWS, GCP, Azure, or RAGFlow to let agents perform cloud tasks and retrieve knowledge</p>
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4 mr-2" /> Add your first integration
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {toolIntegrations.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Wrench className="w-4 h-4 text-blue-500" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Tool Integrations</h2>
                <Badge variant="secondary" className="text-xs">{toolIntegrations.length}</Badge>
              </div>
              <div className="grid gap-4">
                {toolIntegrations.map(renderCard)}
              </div>
            </div>
          )}

          {contextIntegrations.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <BookOpen className="w-4 h-4 text-violet-500" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Context Integrations</h2>
                <Badge variant="secondary" className="text-xs">{contextIntegrations.length}</Badge>
              </div>
              <div className="grid gap-4">
                {contextIntegrations.map(renderCard)}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 p-4 rounded-xl border bg-muted/30">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-1">Security best practices</p>
            <ul className="space-y-1 list-disc ml-4">
              <li>Use dedicated IAM users/service accounts with minimum required permissions</li>
              <li>Never use root account credentials</li>
              <li>Enable audit logs on your cloud provider (CloudTrail, GCP Audit Logs, Azure Monitor)</li>
              <li>Rotate credentials regularly and update them here</li>
              <li>In Docker Compose production, use Docker secrets instead of environment variables</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
