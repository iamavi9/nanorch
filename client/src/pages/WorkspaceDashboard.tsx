import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Network, Bot, Radio, ListTodo, Plus, CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Workspace, Orchestrator, Task } from "@shared/schema";

interface Props {
  workspaceId: string;
}

interface WorkspaceStats {
  orchestrators: number;
  agents: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  pendingTasks: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-400",
  running: "bg-blue-400 animate-pulse",
  completed: "bg-green-400",
  failed: "bg-red-400",
};

export default function WorkspaceDashboard({ workspaceId }: Props) {
  const { data: workspace } = useQuery<Workspace>({ queryKey: [`/api/workspaces/${workspaceId}`] });
  const { data: orchestrators, isLoading: orchLoading } = useQuery<Orchestrator[]>({
    queryKey: [`/api/workspaces/${workspaceId}/orchestrators`],
  });
  const { data: stats } = useQuery<WorkspaceStats>({
    queryKey: [`/api/workspaces/${workspaceId}/stats`],
    refetchInterval: 10000,
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{workspace?.name ?? "Dashboard"}</h1>
        {workspace?.description && <p className="text-muted-foreground mt-1">{workspace.description}</p>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Network} label="Orchestrators" value={stats?.orchestrators ?? orchestrators?.length ?? 0} color="text-primary" loading={!stats && orchLoading} />
        <StatCard icon={Bot} label="Agents" value={stats?.agents ?? 0} color="text-violet-400" loading={!stats} />
        <StatCard icon={CheckCircle} label="Completed" value={stats?.completedTasks ?? 0} color="text-green-400" loading={!stats} />
        <StatCard icon={XCircle} label="Failed" value={stats?.failedTasks ?? 0} color="text-red-400" loading={!stats} />
      </div>

      {(stats?.runningTasks ?? 0) > 0 || (stats?.pendingTasks ?? 0) > 0 ? (
        <div className="flex gap-3 mb-6">
          {(stats?.runningTasks ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-blue-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {stats!.runningTasks} running
            </div>
          )}
          {(stats?.pendingTasks ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-yellow-400">
              <Clock className="w-3.5 h-3.5" />
              {stats!.pendingTasks} pending
            </div>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Orchestrators</h2>
        <Link href={`/workspaces/${workspaceId}/orchestrators/new`}>
          <Button size="sm" data-testid="button-create-orchestrator-dashboard">
            <Plus className="w-4 h-4 mr-1" /> New Orchestrator
          </Button>
        </Link>
      </div>

      {orchLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : orchestrators?.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Network className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No orchestrators yet. Create one to start running agents.</p>
            <Link href={`/workspaces/${workspaceId}/orchestrators/new`}>
              <Button className="mt-4" data-testid="button-create-first-orchestrator">
                <Plus className="w-4 h-4 mr-1" /> Create Orchestrator
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {orchestrators?.map((orch) => (
            <OrchestratorCard key={orch.id} orch={orch} workspaceId={workspaceId} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color, loading }: { icon: any; label: string; value: number; color: string; loading?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={`w-8 h-8 ${color}`} />
        <div>
          {loading ? (
            <Skeleton className="h-7 w-8 mb-1" />
          ) : (
            <div className="text-2xl font-bold" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>{value}</div>
          )}
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrchestratorCard({ orch, workspaceId }: { orch: Orchestrator; workspaceId: string }) {
  const { data: recentTasks } = useQuery<Task[]>({
    queryKey: [`/api/orchestrators/${orch.id}/tasks`],
  });

  const base = `/workspaces/${workspaceId}/orchestrators/${orch.id}`;

  return (
    <Card className="hover:border-primary/40 transition-colors" data-testid={`card-orchestrator-${orch.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">{orch.name}</CardTitle>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-xs capitalize">{orch.provider}</Badge>
              <Badge variant="secondary" className="text-xs font-mono">{orch.model}</Badge>
              <Badge className={`text-xs ${orch.status === "active" ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"}`}>
                {orch.status}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1 mb-3">
          {recentTasks?.slice(0, 10).map((t) => (
            <div key={t.id} className={`w-2 h-2 rounded-full ${STATUS_COLORS[t.status ?? "pending"]}`}
              title={t.status ?? "pending"} />
          ))}
          {(!recentTasks || recentTasks.length === 0) && (
            <span className="text-xs text-muted-foreground">No tasks yet</span>
          )}
        </div>
        <div className="flex gap-2">
          <Link href={base}>
            <Button variant="outline" size="sm" data-testid={`button-open-orchestrator-${orch.id}`}>View</Button>
          </Link>
          <Link href={`${base}/agents`}>
            <Button variant="ghost" size="sm"><Bot className="w-3.5 h-3.5 mr-1" />Agents</Button>
          </Link>
          <Link href={`${base}/tasks`}>
            <Button variant="ghost" size="sm"><ListTodo className="w-3.5 h-3.5 mr-1" />Tasks</Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
