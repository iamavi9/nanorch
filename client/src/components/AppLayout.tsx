import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Bot, LayoutDashboard, Network, Radio, ListTodo, ChevronLeft, Moon, Sun, Zap, Plug, MessageSquare, Users, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "./ThemeProvider";
import { APP_NAME } from "@/lib/config";
import { useAuth, useLogout } from "@/hooks/useAuth";
import type { Workspace, Orchestrator } from "@shared/schema";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

interface AppLayoutProps {
  workspaceId: string;
  children: React.ReactNode;
}

export default function AppLayout({ workspaceId, children }: AppLayoutProps) {
  const { theme, toggleTheme } = useTheme();
  const [location] = useLocation();
  const { user } = useAuth();
  const logout = useLogout();

  const { data: workspace } = useQuery<Workspace>({
    queryKey: [`/api/workspaces/${workspaceId}`],
  });

  const { data: orchestrators } = useQuery<Orchestrator[]>({
    queryKey: [`/api/workspaces/${workspaceId}/orchestrators`],
  });

  const basePath = `/workspaces/${workspaceId}`;

  const navItems = [
    { label: "Dashboard", icon: LayoutDashboard, path: basePath },
    { label: "Chat", icon: MessageSquare, path: `${basePath}/chat` },
    { label: "Members", icon: Users, path: `${basePath}/members` },
    { label: "Integrations", icon: Plug, path: `${basePath}/integrations` },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="w-64 flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border shrink-0">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-sidebar-border">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-sidebar-foreground/60 uppercase tracking-wider truncate">{APP_NAME}</div>
            <div className="text-sm font-semibold truncate">{workspace?.name ?? "Loading..."}</div>
          </div>
        </div>

        <ScrollArea className="flex-1 py-2">
          <nav className="px-2 space-y-0.5">
            <Link
              href="/workspaces"
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              All Workspaces
            </Link>

            <div className="pt-2 pb-1 px-3">
              <span className="text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider">Workspace</span>
            </div>

            {navItems.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors",
                  location === item.path
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            ))}

            {orchestrators && orchestrators.length > 0 && (
              <>
                <div className="pt-4 pb-1 px-3">
                  <span className="text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider">Orchestrators</span>
                </div>
                {orchestrators.map((orch) => {
                  const orchBase = `${basePath}/orchestrators/${orch.id}`;
                  const isActive = location.startsWith(orchBase);
                  return (
                    <div key={orch.id}>
                      <Link
                        href={orchBase}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        )}
                      >
                        <Network className="w-4 h-4" />
                        <span className="truncate">{orch.name}</span>
                      </Link>
                      {isActive && (
                        <div className="ml-4 mt-0.5 space-y-0.5">
                          {[
                            { label: "Agents", icon: Bot, path: `${orchBase}/agents` },
                            { label: "Channels", icon: Radio, path: `${orchBase}/channels` },
                            { label: "Tasks", icon: ListTodo, path: `${orchBase}/tasks` },
                          ].map((sub) => (
                            <Link
                              key={sub.path}
                              href={sub.path}
                              className={cn(
                                "flex items-center gap-2 px-3 py-1.5 text-xs rounded-md transition-colors",
                                location.startsWith(sub.path)
                                  ? "bg-sidebar-primary/20 text-sidebar-primary font-medium"
                                  : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                              )}
                            >
                              <sub.icon className="w-3.5 h-3.5" />
                              {sub.label}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </nav>
        </ScrollArea>

        <div className="p-3 border-t border-sidebar-border space-y-1">
          <div className="px-3 py-1.5 flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-xs font-semibold text-primary">
                {(user?.name || user?.username || "?")[0].toUpperCase()}
              </span>
            </div>
            <span className="text-xs text-sidebar-foreground/70 truncate" data-testid="text-current-user">
              {user?.name || user?.username}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="w-full justify-start gap-2 text-sidebar-foreground/70"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="button-logout"
            onClick={() => logout.mutate()}
            className="w-full justify-start gap-2 text-sidebar-foreground/70"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
