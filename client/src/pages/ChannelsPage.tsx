import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Radio, Webhook, Key, Copy, Check, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Channel } from "@shared/schema";

interface Props {
  orchestratorId: string;
}

export default function ChannelsPage({ orchestratorId }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", type: "api" as "api" | "webhook" });
  const [copied, setCopied] = useState<string | null>(null);

  const { data: channels, isLoading } = useQuery<Channel[]>({
    queryKey: [`/api/orchestrators/${orchestratorId}/channels`],
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", `/api/orchestrators/${orchestratorId}/channels`, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/api/orchestrators/${orchestratorId}/channels`] });
      setOpen(false);
      setForm({ name: "", type: "api" });
      toast({ title: "Channel created" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/channels/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/orchestrators/${orchestratorId}/channels`] }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiRequest("PUT", `/api/channels/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/orchestrators/${orchestratorId}/channels`] }),
  });

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const getWebhookUrl = (channel: Channel) => {
    return `${window.location.origin}/api/channels/${channel.id}/webhook`;
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Channels</h1>
          <p className="text-muted-foreground mt-1">Communication endpoints for this orchestrator</p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="button-new-channel">
          <Plus className="w-4 h-4 mr-2" /> New Channel
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <Skeleton key={i} className="h-36" />)}
        </div>
      ) : channels?.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <Radio className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
            <h3 className="font-semibold mb-2">No channels yet</h3>
            <p className="text-muted-foreground mb-4">Create a channel to receive tasks via webhook or API</p>
            <Button onClick={() => setOpen(true)} data-testid="button-create-first-channel">
              <Plus className="w-4 h-4 mr-2" /> Create Channel
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {channels?.map((ch) => (
            <Card key={ch.id} data-testid={`card-channel-${ch.id}`}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {ch.type === "webhook" ? <Webhook className="w-4 h-4 text-primary" /> : <Radio className="w-4 h-4 text-primary" />}
                    <span className="font-semibold">{ch.name}</span>
                    <Badge variant="outline" className="text-xs capitalize">{ch.type}</Badge>
                    <Badge className={ch.isActive
                      ? "text-xs bg-green-500/20 text-green-400 border-green-500/30"
                      : "text-xs bg-muted text-muted-foreground"}>
                      {ch.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8"
                      onClick={() => toggleMutation.mutate({ id: ch.id, isActive: !ch.isActive })}
                      data-testid={`button-toggle-channel-${ch.id}`}>
                      {ch.isActive ? <ToggleRight className="w-4 h-4 text-green-400" /> : <ToggleLeft className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                      onClick={() => deleteMutation.mutate(ch.id)} data-testid={`button-delete-channel-${ch.id}`}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      <Webhook className="w-3 h-3" /> Webhook URL
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs bg-muted/50 rounded px-3 py-2 font-mono truncate">
                        {getWebhookUrl(ch)}
                      </code>
                      <Button variant="outline" size="icon" className="h-8 w-8 shrink-0"
                        onClick={() => copyToClipboard(getWebhookUrl(ch), `url-${ch.id}`)}
                        data-testid={`button-copy-url-${ch.id}`}>
                        {copied === `url-${ch.id}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </div>

                  {ch.apiKey && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                        <Key className="w-3 h-3" /> API Key
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-muted/50 rounded px-3 py-2 font-mono truncate">
                          {ch.apiKey}
                        </code>
                        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0"
                          onClick={() => copyToClipboard(ch.apiKey!, `key-${ch.id}`)}
                          data-testid={`button-copy-key-${ch.id}`}>
                          {copied === `key-${ch.id}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Include as <code className="bg-muted px-1 rounded">x-api-key</code> header in requests
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Channel</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="My Webhook" className="mt-1" data-testid="input-channel-name" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v: "api" | "webhook") => setForm({ ...form, type: v })}>
                <SelectTrigger className="mt-1" data-testid="select-channel-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="api">API</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !form.name}
              data-testid="button-submit-channel">
              {createMutation.isPending ? "Creating..." : "Create Channel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
