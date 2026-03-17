import { useQuery } from "@tanstack/react-query";
import { useAuth, useLogout } from "@/hooks/useAuth";
import { APP_NAME } from "@/lib/config";
import { Bot, LogOut, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import ChatPage from "@/pages/ChatPage";
import type { Workspace } from "@shared/schema";

interface MemberChatPageProps {
  slug: string;
}

export default function MemberChatPage({ slug }: MemberChatPageProps) {
  const { user } = useAuth();
  const logout = useLogout();
  const [, navigate] = useLocation();

  const { data: workspace, isLoading, isError } = useQuery<Workspace>({
    queryKey: ["/api/workspaces/by-slug", slug],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/by-slug/${slug}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (isError || !workspace) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-2">
          <p className="text-muted-foreground">Workspace not found.</p>
          <Button variant="ghost" size="sm" onClick={() => navigate("/member")}>Go back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b px-4 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            data-testid="button-back"
            onClick={() => navigate("/member")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-1.5">
            <Bot className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">{APP_NAME}</span>
          </div>
          <span className="text-sm text-muted-foreground">/ {workspace.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground hidden sm:block">{user?.name || user?.username}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            data-testid="button-logout"
            onClick={() => logout.mutate()}
          >
            <LogOut className="h-3.5 w-3.5 mr-1" />
            Sign out
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <ChatPage workspaceId={workspace.id} />
      </div>
    </div>
  );
}
