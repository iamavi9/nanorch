import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "./components/ThemeProvider";
import NotFound from "@/pages/not-found";
import WorkspacesPage from "@/pages/WorkspacesPage";
import WorkspaceDashboard from "@/pages/WorkspaceDashboard";
import OrchestratorPage from "@/pages/OrchestratorPage";
import AgentsPage from "@/pages/AgentsPage";
import ChannelsPage from "@/pages/ChannelsPage";
import TasksPage from "@/pages/TasksPage";
import TaskDetailPage from "@/pages/TaskDetailPage";
import IntegrationsPage from "@/pages/IntegrationsPage";
import ChatPage from "@/pages/ChatPage";
import MembersPage from "@/pages/MembersPage";
import LoginPage from "@/pages/LoginPage";
import MemberHomePage from "@/pages/MemberHomePage";
import MemberChatPage from "@/pages/MemberChatPage";
import AppLayout from "@/components/AppLayout";
import { useAuth } from "@/hooks/useAuth";

function AuthGuard({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return <Redirect to={`/login?redirect=${encodeURIComponent(location)}`} />;
  }

  if (adminOnly && user.role !== "admin") {
    return <Redirect to="/member" />;
  }

  return <>{children}</>;
}

function RootRedirect() {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) return <Redirect to="/login" />;
  if (user.role === "admin") return <Redirect to="/workspaces" />;
  return <Redirect to="/member" />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootRedirect} />
      <Route path="/login" component={LoginPage} />

      {/* Member routes */}
      <Route path="/member">
        <AuthGuard>
          <MemberHomePage />
        </AuthGuard>
      </Route>
      <Route path="/chat/:slug">
        {(params) => (
          <AuthGuard>
            <MemberChatPage slug={params.slug} />
          </AuthGuard>
        )}
      </Route>

      {/* Admin routes */}
      <Route path="/workspaces">
        <AuthGuard adminOnly>
          <WorkspacesPage />
        </AuthGuard>
      </Route>
      <Route path="/workspaces/:wid">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <WorkspaceDashboard workspaceId={params.wid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/members">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <MembersPage workspaceId={params.wid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/orchestrators/:oid">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <OrchestratorPage workspaceId={params.wid} orchestratorId={params.oid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/orchestrators/:oid/agents">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <AgentsPage orchestratorId={params.oid} workspaceId={params.wid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/orchestrators/:oid/channels">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <ChannelsPage orchestratorId={params.oid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/orchestrators/:oid/tasks">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <TasksPage orchestratorId={params.oid} workspaceId={params.wid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/orchestrators/:oid/tasks/:tid">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <TaskDetailPage taskId={params.tid} workspaceId={params.wid} orchestratorId={params.oid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/integrations">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <IntegrationsPage workspaceId={params.wid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>
      <Route path="/workspaces/:wid/chat">
        {(params) => (
          <AuthGuard adminOnly>
            <AppLayout workspaceId={params.wid}>
              <ChatPage workspaceId={params.wid} />
            </AppLayout>
          </AuthGuard>
        )}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
