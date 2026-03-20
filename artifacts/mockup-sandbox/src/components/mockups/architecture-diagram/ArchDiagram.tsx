import {
  Globe, Shield, Users, Zap, GitBranch, Clock, Radio, Heart,
  CheckSquare, Database, BarChart2, Server, Cloud, MessageSquare,
  Webhook, Bot, Cpu, Lock, Bell, ArrowRight, ArrowDown,
} from "lucide-react";

function LayerLabel({ color, children }: { color: string; children: string }) {
  return (
    <div className={`text-[10px] font-bold uppercase tracking-widest ${color} mb-2 opacity-70`}>
      {children}
    </div>
  );
}

function Chip({
  icon: Icon,
  label,
  sub,
  accent,
  wide,
}: {
  icon: any;
  label: string;
  sub?: string;
  accent: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${accent} ${wide ? "flex-1" : ""}`}
      style={{ minWidth: wide ? 0 : undefined }}
    >
      <Icon className="shrink-0 w-4 h-4 opacity-90" />
      <div className="min-w-0">
        <div className="text-[11px] font-semibold leading-tight text-white whitespace-nowrap">{label}</div>
        {sub && <div className="text-[9px] opacity-50 leading-tight mt-0.5 whitespace-nowrap">{sub}</div>}
      </div>
    </div>
  );
}

function SectionBox({
  title,
  titleColor,
  borderColor,
  children,
  className = "",
}: {
  title: string;
  titleColor: string;
  borderColor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border ${borderColor} bg-white/[0.03] p-3 ${className}`}>
      <div className={`text-[9px] font-black uppercase tracking-[0.2em] ${titleColor} mb-2.5 opacity-80`}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ArrowV() {
  return (
    <div className="flex justify-center my-1">
      <ArrowDown className="w-4 h-4 text-white/20" />
    </div>
  );
}

export function ArchDiagram() {
  return (
    <div
      className="min-h-screen w-full p-6 font-['Inter']"
      style={{ background: "linear-gradient(135deg, #0a0e1a 0%, #0d1324 50%, #0a0f1e 100%)" }}
    >
      <div className="max-w-[1280px] mx-auto">

        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-full px-4 py-1.5 mb-3">
            <Bot className="w-4 h-4 text-blue-400" />
            <span className="text-blue-300 text-xs font-semibold tracking-wide">Enterprise AI Orchestration Platform</span>
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight mb-1">
            Nano<span className="text-blue-400">Orch</span>
          </h1>
          <p className="text-white/40 text-xs tracking-widest uppercase">System Architecture</p>
        </div>

        {/* Row 1: Access + Auth */}
        <SectionBox title="Access & Identity" titleColor="text-violet-300" borderColor="border-violet-500/25" className="mb-3">
          <div className="flex gap-2 flex-wrap">
            <Chip icon={Globe} label="Web Browser" sub="React + Vite SPA" accent="bg-violet-500/10 border-violet-500/25 text-violet-200" />
            <div className="flex items-center"><ArrowRight className="w-4 h-4 text-white/20" /></div>
            <Chip icon={Lock} label="SSO" sub="OIDC + SAML" accent="bg-violet-500/10 border-violet-500/25 text-violet-200" />
            <div className="flex items-center"><ArrowRight className="w-4 h-4 text-white/20" /></div>
            <Chip icon={Users} label="3-Tier RBAC" sub="Super Admin · Workspace Admin · Member" accent="bg-violet-500/10 border-violet-500/25 text-violet-200" />
            <div className="flex items-center"><ArrowRight className="w-4 h-4 text-white/20" /></div>
            <Chip icon={Shield} label="API Gateway" sub="Session Auth · CSRF · Rate Limits" accent="bg-violet-500/10 border-violet-500/25 text-violet-200" />
          </div>
        </SectionBox>

        <ArrowV />

        {/* Row 2: Core Platform — 3 columns */}
        <div className="grid grid-cols-3 gap-3 mb-3">

          {/* Orchestration Engine */}
          <SectionBox title="Orchestration Engine" titleColor="text-blue-300" borderColor="border-blue-500/25">
            <div className="flex flex-col gap-1.5">
              <Chip icon={Zap} label="Task Executor" sub="Parallel · Retry · Failover" accent="bg-blue-500/10 border-blue-500/20 text-blue-200" wide />
              <Chip icon={GitBranch} label="Pipeline / DAG" sub="Multi-step chaining" accent="bg-blue-500/10 border-blue-500/20 text-blue-200" wide />
              <Chip icon={Clock} label="Cron Scheduler" sub="Timezone-aware jobs" accent="bg-blue-500/10 border-blue-500/20 text-blue-200" wide />
              <Chip icon={Radio} label="Event Triggers" sub="GitHub · GitLab · Jira webhooks" accent="bg-blue-500/10 border-blue-500/20 text-blue-200" wide />
              <Chip icon={Heart} label="Heartbeat Monitor" sub="Per-agent health checks" accent="bg-blue-500/10 border-blue-500/20 text-blue-200" wide />
              <Chip icon={CheckSquare} label="Approval Gates" sub="Human-in-the-loop" accent="bg-blue-500/10 border-blue-500/20 text-blue-200" wide />
            </div>
          </SectionBox>

          {/* Multi-tenant Workspaces */}
          <SectionBox title="Multi-Tenant Workspaces" titleColor="text-cyan-300" borderColor="border-cyan-500/25">
            <div className="flex flex-col gap-1.5">
              <Chip icon={Server} label="Orchestrators" sub="Provider · Model · Concurrency" accent="bg-cyan-500/10 border-cyan-500/20 text-cyan-200" wide />
              <Chip icon={Bot} label="Agents" sub="Instructions · Tools · Memory" accent="bg-cyan-500/10 border-cyan-500/20 text-cyan-200" wide />
              <Chip icon={Users} label="Workspace Members" sub="Isolated per tenant" accent="bg-cyan-500/10 border-cyan-500/20 text-cyan-200" wide />
              <Chip icon={Lock} label="Resource Limits" sub="Orchestrators · Agents · Channels" accent="bg-cyan-500/10 border-cyan-500/20 text-cyan-200" wide />
              <Chip icon={BarChart2} label="Observability" sub="Token usage · Utilization alerts" accent="bg-cyan-500/10 border-cyan-500/20 text-cyan-200" wide />
              <Chip icon={Bell} label="Channel Delivery" sub="Task · Heartbeat · Pipeline · Job" accent="bg-cyan-500/10 border-cyan-500/20 text-cyan-200" wide />
            </div>
          </SectionBox>

          {/* Integrations */}
          <div className="flex flex-col gap-3">
            <SectionBox title="Two-Way Messaging" titleColor="text-emerald-300" borderColor="border-emerald-500/25">
              <div className="flex flex-col gap-1.5">
                <Chip icon={MessageSquare} label="Slack" sub="Inbound + Outbound" accent="bg-emerald-500/10 border-emerald-500/20 text-emerald-200" wide />
                <Chip icon={MessageSquare} label="Microsoft Teams" sub="Inbound + Outbound" accent="bg-emerald-500/10 border-emerald-500/20 text-emerald-200" wide />
                <Chip icon={MessageSquare} label="Google Chat" sub="Inbound + Outbound" accent="bg-emerald-500/10 border-emerald-500/20 text-emerald-200" wide />
                <Chip icon={Webhook} label="Generic Webhook" sub="Outbound delivery" accent="bg-emerald-500/10 border-emerald-500/20 text-emerald-200" wide />
              </div>
            </SectionBox>
            <SectionBox title="Cloud Integrations" titleColor="text-orange-300" borderColor="border-orange-500/25">
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <Chip icon={Cloud} label="AWS" accent="bg-orange-500/10 border-orange-500/20 text-orange-200" wide />
                  <Chip icon={Cloud} label="GCP" accent="bg-orange-500/10 border-orange-500/20 text-orange-200" wide />
                  <Chip icon={Cloud} label="Azure" accent="bg-orange-500/10 border-orange-500/20 text-orange-200" wide />
                </div>
                <div className="flex gap-1.5">
                  <Chip icon={GitBranch} label="GitHub" accent="bg-orange-500/10 border-orange-500/20 text-orange-200" wide />
                  <Chip icon={GitBranch} label="GitLab" accent="bg-orange-500/10 border-orange-500/20 text-orange-200" wide />
                  <Chip icon={CheckSquare} label="Jira" accent="bg-orange-500/10 border-orange-500/20 text-orange-200" wide />
                </div>
              </div>
            </SectionBox>
          </div>
        </div>

        <ArrowV />

        {/* Row 3: AI Providers */}
        <SectionBox title="AI Providers" titleColor="text-pink-300" borderColor="border-pink-500/25" className="mb-3">
          <div className="flex gap-2">
            <Chip icon={Cpu} label="OpenAI" sub="GPT-4o · GPT-4o mini" accent="bg-pink-500/10 border-pink-500/20 text-pink-200" wide />
            <Chip icon={Cpu} label="Anthropic" sub="Claude 3.5 Sonnet +" accent="bg-pink-500/10 border-pink-500/20 text-pink-200" wide />
            <Chip icon={Cpu} label="Google Gemini" sub="Gemini 2.0 Flash +" accent="bg-pink-500/10 border-pink-500/20 text-pink-200" wide />
            <Chip icon={Server} label="Ollama" sub="Self-hosted models" accent="bg-pink-500/10 border-pink-500/20 text-pink-200" wide />
            <div className="flex items-center ml-2">
              <div className="text-[10px] text-white/30 italic">Failover: primary → fallback automatically</div>
            </div>
          </div>
        </SectionBox>

        <ArrowV />

        {/* Row 4: Data */}
        <SectionBox title="Data Layer" titleColor="text-yellow-300" borderColor="border-yellow-500/25">
          <div className="flex gap-2">
            <Chip icon={Database} label="PostgreSQL" sub="Primary data store · Migrations" accent="bg-yellow-500/10 border-yellow-500/20 text-yellow-200" wide />
            <Chip icon={BarChart2} label="Token Usage & Cost" sub="Per workspace · Per model" accent="bg-yellow-500/10 border-yellow-500/20 text-yellow-200" wide />
            <Chip icon={Shield} label="Encrypted Credentials" sub="AES-256-GCM · Docker Secrets" accent="bg-yellow-500/10 border-yellow-500/20 text-yellow-200" wide />
            <Chip icon={Clock} label="Audit Logs" sub="Task logs · Delivery history" accent="bg-yellow-500/10 border-yellow-500/20 text-yellow-200" wide />
          </div>
        </SectionBox>

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between text-white/20 text-[9px]">
          <span>Self-hosted · Docker · PostgreSQL · Express.js · React</span>
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
            Production-ready · Multi-tenant · Enterprise RBAC
          </span>
        </div>
      </div>
    </div>
  );
}
