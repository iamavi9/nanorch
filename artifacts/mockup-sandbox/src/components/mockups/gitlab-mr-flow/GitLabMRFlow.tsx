import {
  User, GitMerge, Webhook, Zap, Bot, Cpu, MessageSquare,
  ArrowRight, ArrowDown, Code, Search, FileText, CheckCircle,
} from "lucide-react";

function StepBadge({ n }: { n: number }) {
  return (
    <div className="w-5 h-5 rounded-full bg-white/10 border border-white/20 flex items-center justify-center shrink-0">
      <span className="text-[9px] font-black text-white/60">{n}</span>
    </div>
  );
}

function FlowCard({
  step,
  icon: Icon,
  title,
  subtitle,
  detail,
  accent,
  tags,
}: {
  step: number;
  icon: any;
  title: string;
  subtitle: string;
  detail: string;
  accent: string;
  tags?: string[];
}) {
  return (
    <div className={`rounded-xl border ${accent.border} ${accent.bg} p-4 flex flex-col gap-2 min-w-[170px] flex-1`}>
      <div className="flex items-center justify-between">
        <StepBadge n={step} />
        <Icon className={`w-5 h-5 ${accent.icon}`} />
      </div>
      <div>
        <div className={`text-[11px] font-black uppercase tracking-widest ${accent.label} opacity-60 mb-0.5`}>
          {subtitle}
        </div>
        <div className="text-sm font-bold text-white leading-tight">{title}</div>
        <div className="text-[10px] text-white/40 mt-1 leading-snug">{detail}</div>
      </div>
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {tags.map((t) => (
            <span
              key={t}
              className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-full ${accent.tag}`}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function HArrow() {
  return (
    <div className="flex items-center px-1 shrink-0">
      <ArrowRight className="w-4 h-4 text-white/20" />
    </div>
  );
}

function VArrow() {
  return (
    <div className="flex justify-center my-2">
      <ArrowDown className="w-4 h-4 text-white/20" />
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[8px] font-black uppercase tracking-[0.2em] text-white/30 mb-2">
      {children}
    </div>
  );
}

function InternalStep({
  icon: Icon,
  label,
  detail,
  accent,
}: {
  icon: any;
  label: string;
  detail: string;
  accent: string;
}) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border ${accent} bg-white/[0.03] px-3 py-2`}>
      <Icon className="w-3.5 h-3.5 mt-0.5 opacity-70 shrink-0 text-white" />
      <div>
        <div className="text-[10px] font-bold text-white leading-tight">{label}</div>
        <div className="text-[9px] text-white/40 leading-snug mt-0.5">{detail}</div>
      </div>
    </div>
  );
}

export function GitLabMRFlow() {
  return (
    <div
      className="min-h-screen w-full p-8 font-['Inter']"
      style={{ background: "linear-gradient(135deg, #0a0e1a 0%, #0d1324 50%, #0a0f1e 100%)" }}
    >
      <div className="max-w-[1280px] mx-auto">

        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-full px-4 py-1.5 mb-3">
            <GitMerge className="w-4 h-4 text-orange-400" />
            <span className="text-orange-300 text-xs font-semibold tracking-wide">
              GitLab MR Review — End-to-End Flow
            </span>
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight mb-1">
            Nano<span className="text-blue-400">Orch</span>
            <span className="text-white/40 font-light ml-2 text-lg">× GitLab × Google Chat</span>
          </h1>
          <p className="text-white/40 text-[10px] tracking-widest uppercase">
            Automated AI-powered merge request analysis and delivery
          </p>
        </div>

        {/* ── Row 1: External trigger ── */}
        <SectionLabel>1 · External Trigger</SectionLabel>
        <div className="flex items-stretch gap-0 mb-1">
          <FlowCard
            step={1}
            icon={User}
            title="Developer Creates MR"
            subtitle="GitLab"
            detail="Opens a merge request: sets title, description, source branch, target branch, and reviewers."
            accent={{
              border: "border-violet-500/30",
              bg: "bg-violet-500/[0.07]",
              icon: "text-violet-300",
              label: "text-violet-300",
              tag: "bg-violet-500/20 text-violet-300",
            }}
            tags={["source branch", "target branch", "title & description"]}
          />
          <HArrow />
          <FlowCard
            step={2}
            icon={GitMerge}
            title="GitLab Fires Webhook"
            subtitle="Merge Request Hook"
            detail='GitLab POSTs a JSON payload to NanoOrch with X-Gitlab-Event: "Merge Request Hook" and the configured secret token.'
            accent={{
              border: "border-orange-500/30",
              bg: "bg-orange-500/[0.07]",
              icon: "text-orange-300",
              label: "text-orange-300",
              tag: "bg-orange-500/20 text-orange-300",
            }}
            tags={["X-Gitlab-Event", "secret token", "JSON payload"]}
          />
          <HArrow />
          <FlowCard
            step={3}
            icon={Webhook}
            title="NanoOrch Receives Event"
            subtitle="Webhook Endpoint"
            detail="POST /api/webhooks/gitlab/{triggerId} — validates the GitLab secret token, then calls fireTrigger()."
            accent={{
              border: "border-blue-500/30",
              bg: "bg-blue-500/[0.07]",
              icon: "text-blue-300",
              label: "text-blue-300",
              tag: "bg-blue-500/20 text-blue-300",
            }}
            tags={["token validation", "fireTrigger()", "event type filter"]}
          />
        </div>

        <VArrow />

        {/* ── Row 2: Agent execution ── */}
        <SectionLabel>2 · NanoOrch Agent Execution</SectionLabel>
        <div className="grid grid-cols-2 gap-3 mb-1">

          {/* Left: tool calls */}
          <div className="rounded-xl border border-blue-500/25 bg-blue-500/[0.04] p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-blue-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-blue-300">
                Step 4 · Agent Spawned
              </span>
            </div>
            <div className="text-[10px] text-white/40 mb-3 leading-snug">
              The trigger renders the system prompt with{" "}
              <code className="text-blue-300/70 bg-blue-500/10 px-1 rounded">{"{{payload.*}}"}</code>{" "}
              variables (MR title, URL, author, branch), then enqueues a task for the configured
              agent.
            </div>
            <div className="flex flex-col gap-2">
              <InternalStep
                icon={Search}
                label="Tool Call: gitlab_get_merge_request"
                detail="Fetches full MR details — diff hunks, changed files, commit messages, and reviewer assignments from the GitLab API."
                accent="border-orange-500/20"
              />
              <div className="flex justify-center">
                <ArrowDown className="w-3 h-3 text-white/20" />
              </div>
              <InternalStep
                icon={FileText}
                label="Tool Call: gitlab_list_mr_changes"
                detail="Retrieves the raw unified diff per file so the LLM can reason about exactly what changed and why."
                accent="border-orange-500/20"
              />
            </div>
          </div>

          {/* Right: LLM inference */}
          <div className="rounded-xl border border-pink-500/25 bg-pink-500/[0.04] p-4">
            <div className="flex items-center gap-2 mb-3">
              <Cpu className="w-4 h-4 text-pink-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-pink-300">
                Step 5 · LLM Inference
              </span>
            </div>
            <div className="text-[10px] text-white/40 mb-3 leading-snug">
              The agent feeds MR details and the full diff into the configured LLM provider
              (Claude / GPT-4o / Gemini). The model generates a structured code review.
            </div>
            <div className="flex flex-col gap-2">
              <InternalStep
                icon={Bot}
                label="Code Review Analysis"
                detail="LLM evaluates logic correctness, naming conventions, potential bugs, security issues, and test coverage gaps."
                accent="border-pink-500/20"
              />
              <div className="flex justify-center">
                <ArrowDown className="w-3 h-3 text-white/20" />
              </div>
              <InternalStep
                icon={Code}
                label="Structured Suggestions Generated"
                detail='Produces per-file inline comments, an overall summary, a risk rating (Low / Medium / High), and an "Approve / Request Changes" recommendation.'
                accent="border-pink-500/20"
              />
            </div>
          </div>
        </div>

        <VArrow />

        {/* ── Row 3: Delivery ── */}
        <SectionLabel>3 · Delivery via Google Chat</SectionLabel>
        <div className="flex items-stretch gap-0 mb-1">
          <FlowCard
            step={6}
            icon={Zap}
            title="NanoOrch Notifier Dispatches"
            subtitle="Channel Delivery"
            detail="The task result is routed to the configured Google Chat channel via the NanoOrch notifier, formatting the output as a structured card message."
            accent={{
              border: "border-cyan-500/30",
              bg: "bg-cyan-500/[0.07]",
              icon: "text-cyan-300",
              label: "text-cyan-300",
              tag: "bg-cyan-500/20 text-cyan-300",
            }}
            tags={["outbound delivery", "channel routing", "card formatter"]}
          />
          <HArrow />
          <FlowCard
            step={7}
            icon={MessageSquare}
            title="Google Chat Card Delivered"
            subtitle="Google Chat"
            detail="The team receives a rich card: MR title, author, branch info, per-file suggestions, risk rating, and the AI recommendation — all in the workspace channel."
            accent={{
              border: "border-emerald-500/30",
              bg: "bg-emerald-500/[0.07]",
              icon: "text-emerald-300",
              label: "text-emerald-300",
              tag: "bg-emerald-500/20 text-emerald-300",
            }}
            tags={["MR summary", "inline suggestions", "risk rating", "recommendation"]}
          />
          <HArrow />
          <FlowCard
            step={8}
            icon={CheckCircle}
            title="Team Reviews and Approves"
            subtitle="Developer"
            detail="Reviewers read the AI-generated explanation and suggestions directly in Google Chat, then approve or request changes on the GitLab MR page."
            accent={{
              border: "border-violet-500/30",
              bg: "bg-violet-500/[0.07]",
              icon: "text-violet-300",
              label: "text-violet-300",
              tag: "bg-violet-500/20 text-violet-300",
            }}
            tags={["approve / request changes", "GitLab MR", "audit trail"]}
          />
        </div>

        {/* Footer legend */}
        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {[
              { color: "bg-violet-400", label: "Developer" },
              { color: "bg-orange-400", label: "GitLab" },
              { color: "bg-blue-400", label: "NanoOrch Engine" },
              { color: "bg-pink-400", label: "AI Provider" },
              { color: "bg-emerald-400", label: "Google Chat" },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${color}`} />
                <span className="text-[9px] text-white/30">{label}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[9px] text-white/25">
              Fully automated · No human step required between MR creation and review delivery
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
