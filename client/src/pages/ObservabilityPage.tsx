import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { BarChart2, Zap, DollarSign, Activity } from "lucide-react";
import { useState } from "react";

interface ObservabilityPageProps {
  workspaceId: string;
}

interface ObsStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byAgent: Array<{ agentName: string; inputTokens: number; outputTokens: number; costUsd: number; calls: number }>;
  byDay: Array<{ date: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  byProvider: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  recentUsage: Array<{ id: string; agentName: string | null; provider: string; model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number | null; createdAt: string }>;
}

function StatCard({ title, value, sub, icon: Icon, color }: { title: string; value: string; sub?: string; icon: any; color: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold mt-1" data-testid={`stat-${title.toLowerCase().replace(/\s/g,"-")}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ObservabilityPage({ workspaceId }: ObservabilityPageProps) {
  const [days, setDays] = useState("30");

  const { data: stats, isLoading } = useQuery<ObsStats>({
    queryKey: [`/api/workspaces/${workspaceId}/observability`, days],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/observability?days=${days}`, { credentials: "include" });
      return res.json();
    },
  });

  const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-primary" />
            Observability
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Token usage, cost tracking, and agent performance metrics.</p>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-32" data-testid="select-days">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading && <p className="text-muted-foreground text-sm">Loading metrics…</p>}

      {!isLoading && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="Total Tokens" value={fmt(totalTokens)} sub={`${fmt(stats?.totalInputTokens ?? 0)} in / ${fmt(stats?.totalOutputTokens ?? 0)} out`} icon={Zap} color="bg-blue-500" />
            <StatCard title="Est. Cost" value={`$${(stats?.totalCostUsd ?? 0).toFixed(4)}`} sub={`Last ${days} days`} icon={DollarSign} color="bg-emerald-500" />
            <StatCard title="Agent Calls" value={String(stats?.recentUsage?.length ?? 0)} sub="Token records" icon={Activity} color="bg-violet-500" />
            <StatCard title="Active Agents" value={String(stats?.byAgent?.length ?? 0)} sub="With usage" icon={BarChart2} color="bg-orange-500" />
          </div>

          {(stats?.byDay?.length ?? 0) > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Daily Token Usage</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={stats!.byDay} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={fmt} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: number) => fmt(v)} />
                    <Legend />
                    <Line type="monotone" dataKey="inputTokens" name="Input Tokens" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="outputTokens" name="Output Tokens" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(stats?.byAgent?.length ?? 0) > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">Tokens by Agent</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stats!.byAgent.slice(0, 8)} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="agentName" tick={{ fontSize: 10 }} />
                      <YAxis tickFormatter={fmt} tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v: number) => fmt(v)} />
                      <Legend />
                      <Bar dataKey="inputTokens" name="Input" fill="#3b82f6" radius={[2,2,0,0]} />
                      <Bar dataKey="outputTokens" name="Output" fill="#8b5cf6" radius={[2,2,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {(stats?.byProvider?.length ?? 0) > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">Usage by Provider / Model</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {stats!.byProvider.map((p) => (
                      <div key={`${p.provider}-${p.model}`} className="flex items-center justify-between text-sm p-2 rounded-md bg-muted/40">
                        <div>
                          <span className="font-medium capitalize">{p.provider}</span>
                          <span className="text-muted-foreground mx-1">·</span>
                          <span className="text-muted-foreground text-xs">{p.model}</span>
                        </div>
                        <div className="text-right text-xs">
                          <div>{fmt(p.inputTokens + p.outputTokens)} tokens</div>
                          <div className="text-muted-foreground">${p.costUsd.toFixed(4)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {(stats?.byAgent?.length ?? 0) > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Agent Performance</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium text-muted-foreground">Agent</th>
                        <th className="text-right py-2 font-medium text-muted-foreground">Calls</th>
                        <th className="text-right py-2 font-medium text-muted-foreground">Input</th>
                        <th className="text-right py-2 font-medium text-muted-foreground">Output</th>
                        <th className="text-right py-2 font-medium text-muted-foreground">Est. Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats!.byAgent.map((a, i) => (
                        <tr key={i} className="border-b last:border-0" data-testid={`row-agent-${i}`}>
                          <td className="py-2 font-medium">{a.agentName}</td>
                          <td className="py-2 text-right text-muted-foreground">{a.calls}</td>
                          <td className="py-2 text-right text-muted-foreground">{fmt(a.inputTokens)}</td>
                          <td className="py-2 text-right text-muted-foreground">{fmt(a.outputTokens)}</td>
                          <td className="py-2 text-right font-medium">${a.costUsd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {totalTokens === 0 && !isLoading && (
            <div className="text-center py-20 text-muted-foreground">
              <BarChart2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No token usage data yet. Run some tasks to see metrics here.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
