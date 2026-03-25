# RespireeClaw

A self-hosted AI personal assistant with cloud automation capabilities.

## Features

- 🤖 **AI Assistant** - Powered by Ollama (supports local and cloud models)
- ☁️ **Cloud Automation** - AWS EC2, RDS, Lambda, S3 management
- 👥 **Agent Teams** - Multi-agent collaboration with supervisor
- 💾 **Memory** - Vector-based semantic search + SQLite storage
- 📱 **Multi-channel** - Telegram, WhatsApp, Slack, Discord, Microsoft Teams, and more
- 🎤 **Voice** - ElevenLabs voice synthesis
- 🌐 **Dashboards** - Web-based management UI
- 🐳 **Docker** - Containerized deployment with persistent storage

## Quick Start

### Option 1: Docker Installation (Recommended)

```bash
# Extract the distribution zip
cd respireeclaw-gateway

# Create environment file
cp .env.example .env
# Edit .env with your API keys and tokens

# Run onboard wizard (first time only)
docker-compose run --rm gateway node agent.js onboard

# Start the gateway
docker-compose up -d

# View logs
docker-compose logs -f gateway
```

**Access the gateway:**
- WebChat: http://localhost:3000
- Canvas: http://localhost:3001
- REST API: http://localhost:3002

### Option 2: Native Installation (Node.js)

```bash
# Clone the repository
git clone https://github.com/sriram162003/respireeclaw.git
cd respireeclaw

# Install dependencies
npm install

# Setup (first time only)
node agent.js onboard

# Start
node agent.js --daemon
```

## Docker

The project includes complete Docker support for easy deployment.

### Docker Compose Services

| Service | Description | Ports |
|---------|-------------|-------|
| `gateway` | Main RespireeClaw Gateway | 3000, 3001, 3002, 8765 |
| `ollama` | Local Ollama service (optional) | 11434 |

### Docker Volumes

Data is persisted in the `aura-data` volume:
- `config.yaml` - Main settings
- `agents.yaml` - Agent definitions
- `keys.yaml` - API keys
- `skills/` - Installed skills
- `memory/` - Vector embeddings + SQLite storage

### Docker Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f gateway

# Restart service
docker-compose restart gateway

# Remove volumes (WARNING: deletes all data!)
docker-compose down -v
```

See [DOCKER.md](DOCKER.md) for detailed Docker instructions.

## Configuration

Configuration is stored in `~/.aura/` (native) or in the `aura-data` volume (Docker):

- `config.yaml` - Main settings, LLM providers, channels
- `agents.yaml` - Agent definitions and personas
- `keys.yaml` - API keys for authentication
- `skills/` - Installed skills (YAML + TypeScript)
- `memory/` - Vector embeddings and SQLite storage
- `logs/` - Application logs

## CLI Commands

### Native Installation

```bash
node agent.js onboard        # First-time setup (interactive)
node agent.js onboard --non-interactive  # Automated setup
node agent.js --daemon       # Start server as daemon
node agent.js status         # Check server status
node agent.js stop           # Stop server
node agent.js logs           # View logs
node agent.js restart        # Restart server
```

### Docker Installation

```bash
# Run onboard wizard
docker-compose run --rm gateway node agent.js onboard

# Start gateway
docker-compose up -d

# Check status
docker-compose exec gateway node agent.js status
```

## Environment Variables

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
# Edit .env with your API keys
```

### LLM Providers

```bash
# Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...

# Google Gemini
GOOGLE_API_KEY=...

# Ollama (local, no API key needed)
# Ollama runs at http://localhost:11434
```

### Messaging Channels

```bash
# Telegram
TELEGRAM_BOT_TOKEN=...

# Discord
DISCORD_BOT_TOKEN=...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

# Microsoft Teams
TEAMS_APP_ID=...
TEAMS_APP_SECRET=...
```

### Voice Synthesis

```bash
# ElevenLabs
ELEVENLABS_API_KEY=...
```

## Tech Stack

- **Runtime**: Node.js 20+
- **LLM**: Ollama, OpenAI, Anthropic, Gemini
- **Storage**: SQLite + Vector embeddings
- **Channels**: Telegram, WhatsApp, Slack, Discord, Teams
- **Containerization**: Docker, Docker Compose

## Requirements

### Native Installation
- Node.js 20+
- npm
- Python 3 (for native modules)
- Build tools (make, g++)

### Docker Installation
- Docker Desktop/Engine
- Docker Compose

## Troubleshooting

### Native Installation Issues

```bash
# Rebuild native modules
npm rebuild better-sqlite3

# Install Playwright browsers
npx playwright install chromium
```

### Docker Installation Issues

```bash
# Rebuild images
docker-compose build --no-cache

# Check logs
docker-compose logs gateway

# Restart services
docker-compose down && docker-compose up -d
```

### EC2/Public IP Access

If accessing via EC2 public IP and the dashboard doesn't load:
1. Ensure ports 3000, 3001, 3002 are open in your security group
2. Access via `http://<EC2_PUBLIC_IP>:3000`
3. See DOCKER.md for CORS configuration

## Documentation

- [DOCKER.md](DOCKER.md) - Docker installation and configuration
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guidelines

## License

MIT
