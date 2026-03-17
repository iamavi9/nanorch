import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";
import { Plus, Network, Zap, Trash2, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useTheme } from "@/components/ThemeProvider";
import type { Workspace } from "@shared/schema";

export default function WorkspacesPage() {
  const { toast } = useToast();
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", description: "" });

  const { data: workspaces, isLoading } = useQuery<Workspace[]>({ queryKey: ["/api/workspaces"] });

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", "/api/workspaces", data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/workspaces"] });
      setOpen(false);
      setForm({ name: "", slug: "", description: "" });
      toast({ title: "Workspace created" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/workspaces/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/workspaces"] }),
  });

  const handleNameChange = (name: string) => {
    setForm((f) => ({
      ...f,
      name,
      slug: f.slug || name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    }));
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg">{APP_NAME}</span>
            <Badge variant="secondary" className="text-xs">{APP_TAGLINE}</Badge>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} data-testid="button-toggle-theme">
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Workspaces</h1>
            <p className="text-muted-foreground mt-1">Isolated environments for each team or use case</p>
          </div>
          <Button onClick={() => setOpen(true)} data-testid="button-create-workspace">
            <Plus className="w-4 h-4 mr-2" />
            New Workspace
          </Button>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-48" />)}
          </div>
        ) : workspaces?.length === 0 ? (
          <div className="text-center py-24">
            <Network className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No workspaces yet</h3>
            <p className="text-muted-foreground mb-6">Create your first workspace to get started</p>
            <Button onClick={() => setOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Create Workspace
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {workspaces?.map((ws) => (
              <Card key={ws.id} className="hover:border-primary/50 transition-colors group" data-testid={`card-workspace-${ws.id}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-2">
                      <Network className="w-5 h-5 text-primary" />
                    </div>
                    <Button
                      variant="ghost" size="icon"
                      className="opacity-0 group-hover:opacity-100 h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.preventDefault(); deleteMutation.mutate(ws.id); }}
                      data-testid={`button-delete-workspace-${ws.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <CardTitle className="text-base">{ws.name}</CardTitle>
                  <CardDescription className="text-xs font-mono text-muted-foreground">{ws.slug}</CardDescription>
                </CardHeader>
                <CardContent>
                  {ws.description && <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{ws.description}</p>}
                  <Link href={`/workspaces/${ws.id}`}>
                    <Button variant="outline" size="sm" className="w-full" data-testid={`button-open-workspace-${ws.id}`}>
                      Open Workspace
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="ws-name">Name</Label>
              <Input id="ws-name" value={form.name} onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Team" className="mt-1" data-testid="input-workspace-name" />
            </div>
            <div>
              <Label htmlFor="ws-slug">Slug</Label>
              <Input id="ws-slug" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="my-team" className="mt-1 font-mono" data-testid="input-workspace-slug" />
            </div>
            <div>
              <Label htmlFor="ws-desc">Description</Label>
              <Textarea id="ws-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description..." className="mt-1" rows={3} data-testid="input-workspace-description" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !form.name || !form.slug}
              data-testid="button-submit-workspace">
              {createMutation.isPending ? "Creating..." : "Create Workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
