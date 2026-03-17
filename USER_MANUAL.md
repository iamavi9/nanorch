# NanoOrch — User Manual

Welcome to NanoOrch. This guide covers everything you need to know as a chat user — no technical background required.

---

## Table of Contents

1. [Logging in](#1-logging-in)
2. [Your workspace list](#2-your-workspace-list)
3. [Opening the chat](#3-opening-the-chat)
4. [Talking to an agent](#4-talking-to-an-agent)
5. [Types of responses](#5-types-of-responses)
6. [Approving actions](#6-approving-actions)
7. [When the agent runs code](#7-when-the-agent-runs-code)
8. [Knowledge sources (RAGFlow)](#8-knowledge-sources-ragflow)
9. [Tips for better results](#9-tips-for-better-results)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Logging in

Go to the URL your administrator gave you (e.g. `http://your-company-nanoorch.com`) and log in with your username and password.

> If you have not received a username and password, contact your administrator.

After logging in you will be taken directly to your workspace list.

---

## 2. Your workspace list

You will see the workspaces your administrator has added you to. Each workspace is a separate area — it may represent a team, a project, or a department.

Click any workspace to open its chat.

> You can only see workspaces you have been added to. If a workspace you expect is missing, ask your administrator to add you.

---

## 3. Opening the chat

Once you are inside a workspace, the chat interface opens automatically. This is where you interact with AI agents.

The input box is at the bottom of the screen. Type your message there and press **Enter** (or click the send button) to send it.

---

## 4. Talking to an agent

Agents are AI assistants set up by your administrator. Each one has a name and a specific area of focus — for example, one agent might handle infrastructure questions, another might search your company knowledge base.

### Selecting an agent with @mention

You direct your message to a specific agent using `@` followed by their name:

```
@infra-bot how many EC2 instances do we have running?
```

**How to pick an agent:**

1. Type `@` in the message box — a dropdown list of available agents appears
2. Use the **↑** and **↓** arrow keys to move through the list
3. Press **Enter** or **Tab** to select the highlighted agent (or just click their name)
4. Press **Escape** to close the dropdown without selecting anyone
5. Finish typing your message and press **Enter** to send

The selected agent name appears highlighted in your message before you send it.

> **Always start with @agent-name** — without it the platform does not know which agent to route your message to.

---

## 5. Types of responses

Depending on what you ask, the agent may respond in one of three ways:

### Instant answer

For questions, explanations, and summaries the agent replies directly in the chat — the text streams in word by word as it is generated.

```
@docs-bot what is our data retention policy?
→ Our data retention policy states that...
```

### Computed answer

If your question requires a calculation or data processing, the agent writes a small program, runs it securely on the server, and returns the result.

```
@data-bot what is the compound interest on $50,000 at 4.5% over 10 years?
→ ⚙ running python in sandbox…
→ After 10 years at 4.5% annual compound interest, $50,000 grows to $77,931.29.
```

You will see the `⚙ running … in sandbox…` indicator while the code is executing. It disappears automatically when the result is ready. This usually takes only a second or two.

### Action (requires your approval)

If your request would create, change, or delete something — like creating a cloud resource — the agent pauses and shows you a confirmation card before doing anything. See the next section.

---

## 6. Approving actions

When the agent detects that your request involves a **write operation** (creating, modifying, or deleting something), it stops and shows you a confirmation card like this:

> **Pending action**
> Create S3 bucket `my-backup-bucket` in `us-east-1`
>
> [ Approve ]   [ Cancel ]

- **Approve** — the action runs. You will see a progress indicator and a completion message when it finishes.
- **Cancel** — nothing happens. You can rephrase or ask something different.

> Review the description carefully before approving. Actions that create or delete cloud resources can have real costs and consequences.

If you approved by mistake and the action has not started yet, you can cancel immediately. Once it has started, contact your administrator.

---

## 7. When the agent runs code

Some prompts cause the agent to write and execute code automatically. This is completely safe — the code runs in a locked-down sandbox with no access to the internet or your files, and nothing persists after the run.

You do not need to do anything special. Just ask naturally:

| What you type | What the agent does |
|---|---|
| `@agent is 104729 a prime number?` | Writes a short program, runs it, tells you the answer |
| `@agent convert 212°F to Celsius` | Runs the formula, returns the result |
| `@agent how many days until the end of the quarter?` | Uses today's date, computes the difference |
| `@agent what is the SHA-256 hash of "hello world"?` | Runs a hash function, returns the output |
| `@agent count how many items have status "active": [{"status":"active"},...]` | Parses the data, counts and returns the number |

The sandbox can run Python and JavaScript. It cannot browse the internet, access your files, or remember anything from a previous run.

---

## 8. Knowledge sources (RAGFlow)

If your administrator has connected a company knowledge base (RAGFlow), the agent will automatically search it before every response — you do not need to ask it to.

When relevant documents are found, a collapsible **Sources** panel appears below the agent's reply:

```
[agent reply text here...]

▶ Sources  (3 chunks found)
  • Company Policy v2.pdf — page 4
  • Onboarding Guide — section 3.2
  • Q3 Handbook — page 11
```

Click **Sources** to expand and read the specific document excerpts the agent used to form its answer. This lets you verify the information and find the original document if you need more detail.

---

## 9. Tips for better results

**Be specific.** The more context you give, the better the response.

```
Less specific:   @infra-bot list instances
More specific:   @infra-bot list all EC2 instances in us-east-1 that are currently running
```

**Address the right agent.** Your administrator may have set up specialist agents — one for cloud infrastructure, one for knowledge base search, one for data analysis. Using the right agent gets you a better answer faster.

**Ask follow-up questions.** The agent remembers the context of your current conversation. You can refine or follow up without repeating yourself:

```
@agent list my S3 buckets
→ [lists buckets]

@agent which of those were created in the last 30 days?
→ [filters and replies]
```

**For calculations, paste the data inline.** If you have JSON, CSV, or numbers you want the agent to process, paste them directly into your message.

**If the response is cut off**, ask the agent to continue:

```
@agent continue
```

---

## 10. Troubleshooting

**The agent is not responding / the spinner keeps going**

- Wait up to 30 seconds — some responses (especially ones that run code or call cloud APIs) take longer.
- If it has been more than a minute with no response, try refreshing the page and resending your message.

**"No agents available" in the dropdown**

- Your workspace has no agents configured yet. Ask your administrator to set one up.

**The agent says it cannot run code**

- The code sandbox image may not have been built on the server. Ask your administrator to run `docker build -t nanoorch-sandbox:latest ./agent/sandbox` on the host.

**The agent says it does not have access to a cloud tool**

- The tool may not be enabled for that agent. Ask your administrator to enable it in the agent's settings under **Tools**.

**The action ran but something went wrong**

- Open the task that was created (your administrator can see it in the **Tasks** view) to check the detailed logs. Share those logs with your administrator.

**I cannot see a workspace I should have access to**

- Ask your administrator to add you to that workspace from the **Members** section.

**I forgot my password**

- Ask your administrator to reset it. There is no self-service password reset.

---

## Quick reference

| Goal | How |
|---|---|
| Talk to an agent | Type `@agent-name your message` and press Enter |
| Pick an agent from the list | Type `@`, use ↑↓ arrows, press Enter or Tab |
| Cancel agent selection | Press Escape |
| Approve a pending action | Click **Approve** on the confirmation card |
| See document sources | Click **Sources** below the agent's reply |
| Ask a follow-up | Just keep typing — context is remembered |
| Switch workspace | Go back to the home screen (top-left logo or `/member`) |
