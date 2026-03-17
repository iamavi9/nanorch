import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle, XCircle, Clock, Loader2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Task, TaskLog } from "@shared/schema";
import { formatDistanceToNow, format } from "date-fns";

interface Props {
  taskId: string;
  workspaceId: string;
  orchestratorId: string;
}

const STATUS_CONFIG: Record<string, { icon: any; color: string; badge: string }> = {
  pending: { icon: Clock, color: "text-yellow-400", badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  running: { icon: Loader2, color: "text-blue-400", badge: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  completed: { icon: CheckCircle, color: "text-green-400", badge: "bg-green-500/20 text-green-400 border-green-500/30" },
  failed: { icon: XCircle, color: "text-red-400", badge: "bg-red-500/20 text-red-400 border-red-500/30" },
};

const LOG_COLORS: Record<string, string> = {
  info: "text-foreground",
  warn: "text-yellow-400",
  error: "text-red-400",
};

export default function TaskDetailPage({ taskId, workspaceId, orchestratorId }: Props) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [streaming, setStreaming] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const { data: task, refetch: refetchTask } = useQuery<Task>({
    queryKey: [`/api/tasks/${taskId}`],
    refetchInterval: (query) => {
      const data = query.state.data;
      return (data?.status === "running" || data?.status === "pending") ? 2000 : false;
    },
  });

  useEffect(() => {
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    esRef.current = es;
    setStreaming(true);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "done") {
          setStreaming(false);
          es.close();
          refetchTask();
          return;
        }
        if (data.id) {
          setLogs((prev) => {
            if (prev.some((l) => l.id === data.id)) return prev;
            return [...prev, data];
          });
        }
      } catch {}
    };

    es.onerror = () => {
      setStreaming(false);
      es.close();
    };

    return () => {
      es.close();
    };
  }, [taskId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const statusConfig = STATUS_CONFIG[task?.status ?? "pending"];
  const base = `/workspaces/${workspaceId}/orchestrators/${orchestratorId}`;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`${base}/tasks`}>
          <Button variant="ghost" size="sm" className="gap-1" data-testid="button-back-tasks">
            <ArrowLeft className="w-4 h-4" /> Tasks
          </Button>
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-sm text-muted-foreground">{taskId.slice(0, 8)}...</span>
      </div>

      <div className="grid gap-4 mb-6">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                {statusConfig && <statusConfig.icon className={`w-5 h-5 ${statusConfig.color} ${task?.status === "running" ? "animate-spin" : ""}`} />}
                <Badge className={statusConfig?.badge ?? ""} data-testid="status-task">
                  {task?.status ?? "loading"}
                </Badge>
                {streaming && (
                  <Badge variant="secondary" className="text-xs gap-1 animate-pulse">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    Live
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {task?.createdAt && formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
              </div>
            </div>

            <div className="mb-2">
              <div className="text-xs text-muted-foreground mb-1">Input</div>
              <div className="text-sm bg-muted/50 rounded-md p-3 whitespace-pre-wrap font-mono" data-testid="text-task-input">
                {task?.input}
              </div>
            </div>

            {task?.output && (
              <div>
                <div className="text-xs text-muted-foreground mb-1 mt-3">Output</div>
                <div className="text-sm bg-green-500/5 border border-green-500/20 rounded-md p-3 whitespace-pre-wrap" data-testid="text-task-output">
                  {task.output}
                </div>
              </div>
            )}

            {task?.errorMessage && (
              <div>
                <div className="text-xs text-muted-foreground mb-1 mt-3">Error</div>
                <div className="text-sm bg-red-500/5 border border-red-500/20 rounded-md p-3 text-red-400 font-mono" data-testid="text-task-error">
                  {task.errorMessage}
                </div>
              </div>
            )}

            <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
              {task?.startedAt && <span>Started: {format(new Date(task.startedAt), "HH:mm:ss")}</span>}
              {task?.completedAt && <span>Completed: {format(new Date(task.completedAt), "HH:mm:ss")}</span>}
              {task?.startedAt && task?.completedAt && (
                <span>Duration: {((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000).toFixed(1)}s</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Terminal className="w-4 h-4" /> Execution Logs
              {streaming && <span className="text-xs font-normal text-muted-foreground">(streaming)</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-72">
              <div className="p-4 font-mono text-xs space-y-0.5" data-testid="container-logs">
                {logs.length === 0 && !streaming && (
                  <div className="text-muted-foreground text-center py-8">No logs available</div>
                )}
                {logs.map((log) => (
                  <div key={log.id} className={`flex gap-3 ${LOG_COLORS[log.level ?? "info"]}`}>
                    <span className="text-muted-foreground shrink-0">
                      {log.timestamp ? format(new Date(log.timestamp), "HH:mm:ss.SSS") : ""}
                    </span>
                    <span className={`shrink-0 uppercase text-xs font-bold w-9 ${LOG_COLORS[log.level ?? "info"]}`}>
                      [{log.level}]
                    </span>
                    <span className="break-all">{log.message}</span>
                  </div>
                ))}
                {streaming && (
                  <div className="flex items-center gap-2 text-muted-foreground mt-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Waiting for logs...</span>
                  </div>
                )}
                <div ref={logsEndRef} />
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
