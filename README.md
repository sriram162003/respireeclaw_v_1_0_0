# RespireeClaw Gateway

[![CI](https://github.com/sriram162003/respireeclaw_v_1_0_0/actions/workflows/ci.yml/badge.svg)](https://github.com/sriram162003/respireeclaw_v_1_0_0/actions/workflows/ci.yml)
[![Release](https://github.com/sriram162003/respireeclaw_v_1_0_0/actions/workflows/release.yml/badge.svg)](https://github.com/sriram162003/respireeclaw_v_1_0_0/actions/workflows/release.yml)
[![Docker](https://ghcr-badge.egpl.dev/sriram162003/respireeclaw_v_1_0_0/latest_tag?label=docker)](https://github.com/sriram162003/respireeclaw_v_1_0_0/pkgs/container/respireeclaw_v_1_0_0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted AI agent gateway — your own personal AI brain that runs on any server, connects to any LLM, and talks to you through any channel.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Channels                            │
│  WebChat · Telegram · WhatsApp · Slack · Discord · Teams │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│                  Gateway Core (server.ts)                │
│                                                         │
│   ┌──────────┐  ┌──────────┐  ┌────────────────────┐   │
│   │  Memory  │  │   LLM    │  │   Skills Engine    │   │
│   │ Semantic │  │  Router  │  │  Auto-discovered   │   │
│   │ Profiles │  │ Tiered   │  │  ~/.aura/skills/   │   │
│   └──────────┘  └──────────┘  └────────────────────┘   │
│                                                         │
│   ┌──────────────────────────────────────────────────┐  │
│   │           Agent Orchestrator                     │  │
│   │  Supervisor ──► Worker 1 │ Worker 2 │ Worker N   │  │
│   │  Message Bus · wait_for_user · notify_user       │  │
│   └──────────────────────────────────────────────────┘  │
│                                                         │
│   ┌──────────┐  ┌──────────┐  ┌──────────────────┐     │
│   │Scheduler │  │  Canvas  │  │   REST API       │     │
│   │Workflows │  │    WS    │  │   Dashboards     │     │
│   └──────────┘  └──────────┘  └──────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## Features

| Feature | Description |
|---|---|
| **Multi-LLM** | Claude, GPT-4, Gemini, Ollama (local), Mistral, OpenRouter — hot-swap via config |
| **Agent Teams** | Spawn supervisor + parallel worker agents with a shared message bus |
| **User ↔ Agent** | Workers can `notify_user` and `wait_for_user_message` mid-task |
| **Skills** | Drop a `.ts` + `.yaml` file into `~/.aura/skills/` — auto-loaded, no restart |
| **Memory** | Vector semantic search + long-term user/self profiles + short-term history |
| **Workflows** | YAML-defined cron workflows with `llm`, `http`, `condition`, `transform` steps |
| **Channels** | WebChat, Telegram, WhatsApp, Slack, Discord, Teams, Signal, Google Chat |
| **Canvas** | Real-time WebSocket canvas for rich agent output (tables, code, cards) |
| **Dashboards** | Web UIs for skills, logs, agent teams, Wazuh SIEM |
| **Cloud** | AWS EC2/RDS/Lambda/S3/ECS/CloudWatch via injectable credentials |
| **Docker** | Single container, `aura-data` named volume for all persistent state |

---

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/sriram162003/respireeclaw_v_1_0_0.git
cd respireeclaw_v_1_0_0

# Configure
cp .env.example .env
# Edit .env — minimum: set your LLM API key

# First-time setup (creates ~/.aura/config.yaml interactively)
docker compose run --rm gateway node agent.js onboard

# Start
docker compose up -d

# Follow logs
docker compose logs -f gateway
```

**Endpoints:**

| Service | URL |
|---|---|
| WebChat | http://localhost:3000 |
| Canvas | ws://localhost:3001 |
| REST API | http://localhost:3002 |
| Agent Teams Dashboard | http://localhost:3002/dashboard4 |

### Native (Node.js 20+)

```bash
git clone https://github.com/sriram162003/respireeclaw_v_1_0_0.git
cd respireeclaw_v_1_0_0

npm install
node agent.js onboard   # first time
node agent.js --daemon  # start
node agent.js status    # check
node agent.js logs      # tail logs
node agent.js stop      # stop
```

---

## Configuration

All config lives in `~/.aura/config.yaml` (persisted via Docker volume). The onboard wizard generates it, but you can edit it live — the gateway hot-reloads LLM settings without a restart.

### LLM Tiers

```yaml
llm:
  simple:   ollama/llama3.2        # fast, cheap — greetings, routing
  complex:  anthropic/claude-opus  # best reasoning — agent tasks
  vision:   openai/gpt-4o          # image understanding
  creative: openai/gpt-4o          # writing, brainstorming
  offline:  ollama/llama3.2        # no internet required
```

Supported providers: `anthropic`, `openai`, `ollama`, `gemini`, `mistral`, `openrouter`

### Agent Config (`~/.aura/agents.yaml`)

```yaml
agents:
  - name: Gary
    memory_ns: default
    llm_tier: complex
    persona: |
      You are Gary, a no-nonsense AI assistant.
      You are direct, efficient, and always get the job done.
```

### Environment Variables (`.env`)

```bash
# Required — at least one LLM key
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Channels (all optional)
TELEGRAM_BOT_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
DISCORD_BOT_TOKEN=...

# Security
AURA_API_KEY=sk-aura-...    # auto-generated on first run

# Ports (defaults shown)
WEBCHAT_PORT=3000
CANVAS_PORT=3001
REST_PORT=3002
```

---

## Skills

Skills are the agent's tools. Drop a `.ts` (logic) + `.yaml` (metadata) pair into `~/.aura/skills/` — the watcher picks it up within seconds, no restart needed.

### Bundled Skills

| Skill | Description |
|---|---|
| `cloud_automation` | AWS EC2, RDS, Lambda, S3, ECS, CloudWatch |
| `web_search` | DuckDuckGo search + page fetch |
| `filesystem` | Read/write/list files in the agent's workspace |
| `workflow_automation_v2` | Run/create YAML workflows with LLM steps |
| `selenium_testing` | Browser automation via Selenium WebDriver |
| `github_cli` | GitHub operations via `gh` CLI |
| `notion` | Notion pages and databases |
| `google_calendar` | Calendar events |
| `telegram_send` | Send Telegram messages proactively |
| `twitter` | Twitter/X posting |
| `reminders` | Schedule one-time reminders |
| `wazuh_siem` | Wazuh SIEM queries and alerts |
| `webhooks` | Register and handle inbound webhooks |
| `whoop` | Whoop health data |
| `skill_installer` | Install new skills from URLs |
| `self_config` | Modify the gateway's own config |

### Writing a Custom Skill

**`~/.aura/skills/my_skill.yaml`**
```yaml
name: my_skill
description: Does something useful
enabled: true
tools:
  - name: do_thing
    description: Does the thing
    parameters:
      type: object
      properties:
        input: { type: string, description: Input value }
      required: [input]
```

**`~/.aura/skills/my_skill.ts`**
```typescript
import type { SkillContext } from './types';

export async function do_thing(
  args: { input: string },
  ctx: SkillContext,
): Promise<unknown> {
  // ctx.memory.search(q)        — semantic memory
  // ctx.channel.send(id, text)  — message user
  // ctx.canvas.append(block)    — write to canvas
  // ctx.llm.complete(tier, prompt) — call LLM
  return { result: `Processed: ${args.input}` };
}
```

---

## Agent Teams

Spawn a team from the dashboard at `/dashboard4` or by asking the main agent:

> "Spawn a team to research AWS pricing in us-east-1 and eu-west-1 in parallel"

The orchestrator creates:
- A **supervisor** agent that monitors progress, fixes errors, spawns new agents
- N **worker** agents running in parallel, each with their own task

### Worker Capabilities

Workers get full context: gateway name, user identity, user profile, memory hits, time, and all tools. Key inter-agent / user interaction tools:

| Tool | Description |
|---|---|
| `agent_send` | Send message to a specific teammate |
| `agent_broadcast` | Send to all teammates at once |
| `agent_read` | Check inbox for messages |
| `notify_user` | Send a message directly to the user's chat |
| `wait_for_user_message` | Pause and wait for the user to reply (polls every 2s) |
| `get_team_status` | See status of all agents |
| `get_agent_errors` | List all team errors |

### User ↔ Agent Interaction

The Agent Teams dashboard (`/dashboard4`) has a built-in Messages panel. When a session is running, a compose bar appears — you can message any agent or broadcast to all:

```
Agent greets you via notify_user → appears in Messages panel
You type reply in compose bar → send to "all agents"
wait_for_user_message unblocks → agent continues
```

---

## Workflows

YAML-based workflows with cron scheduling. Stored in `~/.aura/workflows/`.

```yaml
name: daily_report
trigger:
  cron: "0 8 * * *"   # every day at 8am
steps:
  - id: fetch
    type: http
    url: "https://api.example.com/stats"

  - id: analyze
    type: llm
    tier: complex
    prompt: "Analyze this data and write a summary: {{ fetch.body }}"
    on_success: report

  - id: report
    type: http
    method: POST
    url: "{{ env.SLACK_WEBHOOK }}"
    body: '{ "text": "{{ analyze.text }}" }'
```

Step types: `http`, `llm`, `condition`, `transform`, `workflow_run`

---

## Deployment

### Production with GitHub Actions

The repo includes three workflows:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | PR + push to main | Typecheck, tests, Docker build, secret scan |
| `release.yml` | Push to main / version tag | Build multi-arch image → push to GHCR → SSH deploy |
| `dependency-update.yml` | PR touching package.json | Dependency vulnerability review |

### Required GitHub Secrets

Set these in **Settings → Secrets and variables → Actions**:

| Secret | Description |
|---|---|
| `DEPLOY_HOST` | Production server IP or hostname |
| `DEPLOY_USER` | SSH username (e.g. `ubuntu`, `ec2-user`) |
| `DEPLOY_SSH_KEY` | Private SSH key (RSA or Ed25519) |
| `DEPLOY_PATH` | Path on server (default: `/opt/respireeclaw`) |
| `DEPLOY_PORT` | SSH port (default: `22`) |

### Versioned Releases

```bash
git tag v1.2.0
git push origin v1.2.0
```

This triggers: build multi-arch image → push `ghcr.io/sriram162003/respireeclaw_v_1_0_0:1.2.0` → create GitHub Release with auto-changelog.

### Pull from GHCR on your server

```bash
docker pull ghcr.io/sriram162003/respireeclaw_v_1_0_0:main

# Or pin to a version
docker pull ghcr.io/sriram162003/respireeclaw_v_1_0_0:1.2.0
```

---

## REST API

All endpoints require `Authorization: Bearer <AURA_API_KEY>`.

```bash
# Send a message to the agent
POST /api/chat
{ "text": "What is the status of my EC2 instances?", "session_id": "my-session" }

# Get agent sessions
GET /api/orchestrator/sessions

# List skills
GET /api/skills

# Spawn an agent team
POST /dashboard4/api/spawn
{
  "objective": "Research and summarize AWS costs",
  "supervisor": "supervisor",
  "agents": [
    { "role": "researcher", "task": "Pull cost data from AWS Cost Explorer" },
    { "role": "analyst",    "task": "Analyse the data and find top spenders" }
  ]
}

# Send a message to a running team
POST /dashboard4/api/sessions/:id/message
{ "to": "all", "content": "Focus on EC2 costs only" }
```

---

## Data & Persistence

All persistent state lives in the `aura-data` Docker volume at `~/.aura/` inside the container:

```
~/.aura/
├── config.yaml       ← LLM config, channel tokens
├── agents.yaml       ← Agent personas
├── skills/           ← Custom + default skills (auto-discovered)
├── workflows/        ← YAML workflow definitions
├── workspace/        ← Agent file workspace, contacts.md
├── memory/           ← SQLite + vector embeddings
└── logs/             ← Rotating log files
```

To back up:
```bash
docker run --rm -v aura-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/aura-backup-$(date +%Y%m%d).tar.gz -C /data .
```

---

## Updating

```bash
# Pull new image
docker compose pull

# Restart with zero-downtime (new container healthy before old stops)
docker compose up -d --no-deps --wait gateway

# Or do a full rebuild from source
docker compose build --no-cache && docker compose up -d
```

Default skills in the image are synced to the volume on every startup — only files that don't already exist are copied, so your customisations are never overwritten.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
# Dev mode with hot-reload
cp .env.example .env
npm install
npm run dev
```

---

## License

MIT — see [LICENSE](LICENSE).
