# RespireeClaw Gateway - Docker Installation

This document provides instructions for running RespireeClaw Gateway using Docker.

## Prerequisites

- Docker Desktop (Windows/macOS) or Docker Engine (Linux)
- Docker Compose (usually included with Docker Desktop)

## Quick Start

### 1. Create environment file

Copy the example environment file and edit it with your credentials:

```bash
cp .env.example .env
# Edit .env with your API keys and tokens
```

### 2. Run Onboard Wizard (First Time Only)

For the first deployment, run the onboard wizard:

```bash
# Run the onboard wizard
docker-compose run --rm gateway node agent.js onboard
```

This will:
- Create configuration files in the `aura-data` volume
- Generate API keys
- Install default skills
- Set up your agent

**Note:** The onboard wizard only needs to be run once. After that, the configuration is persisted in the Docker volume.

### 3. Start with Docker Compose

```bash
# Build and start the gateway
docker-compose up -d

# View logs
docker-compose logs -f gateway

# Stop the gateway
docker-compose down
```

### 4. Non-Interactive Mode (Optional)

For automated deployments, you can set environment variables in `docker-compose.yml`:

```yaml
environment:
  - AGENT_NAME=MyAgent
  - LLM_PROVIDER=ollama  # or claude, openai, gemini
  - ANTHROPIC_API_KEY=sk-ant-...
  - OPENAI_API_KEY=sk-...
  - GOOGLE_API_KEY=...
```

Then run:
```bash
docker-compose run --rm gateway node agent.js onboard --non-interactive
```

### 3. Access the gateway

- **WebChat**: http://localhost:3000
- **Canvas**: http://localhost:3001
- **REST API**: http://localhost:3002
- **ANP Port**: localhost:8765

## Docker Compose Services

### Production (docker-compose.yml)

| Service | Description | Ports |
|---------|-------------|-------|
| `gateway` | Main RespireeClaw Gateway service | 3000, 3001, 3002, 8765 |

### Development (docker-compose.dev.yml)

| Service | Description | Ports |
|---------|-------------|-------|
| `gateway` | Gateway with hot reload | 3000, 3001, 3002, 8765 |

## Data Persistence

All data is stored in the `aura-data` volume, which persists across container restarts:

### Volume Contents
- `~/.aura/config.yaml` - Main configuration
- `~/.aura/agents.yaml` - Agent definitions
- `~/.aura/keys.yaml` - API keys
- `~/.aura/skills/` - Installed skills
- `~/.aura/memory/` - Vector embeddings and SQLite storage
- `~/.aura/logs/` - Log files

### Managing Volumes

```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect gateway_aura-data

# Backup volume
docker run --rm -v gateway_aura-data:/data -v $(pwd):/backup alpine tar czf /backup/aura-data-backup.tar.gz /data

# Restore volume
docker run --rm -v gateway_aura-data:/data -v $(pwd):/backup alpine sh -c "cd /data && tar xzf /backup/aura-data-backup.tar.gz --strip-components=1"

# Remove volume (WARNING: deletes all data!)
docker volume rm gateway_aura-data
```

### Restart Behavior

The gateway is configured to:
1. **Check for existing configuration** on startup
2. **Skip onboarding** if config files exist in the volume
3. **Persist all data** across container restarts
4. **Recover automatically** from crashes (restart: unless-stopped)

To restart the gateway:
```bash
docker-compose restart gateway
```

To stop and restart (preserves volume):
```bash
docker-compose down
docker-compose up -d
```

## Environment Variables

The following environment variables are required in your `.env` file:

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

# WhatsApp (QR scan on first start)
# No token needed

# Signal
SIGNAL_PHONE_NUMBER=+1234567890
```

### Voice Synthesis
```bash
# ElevenLabs
ELEVENLABS_API_KEY=...
```

### Skills
```bash
# Web Search
SERPAPI_KEY=...

# Notion
NOTION_API_KEY=secret_...

# Spotify
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...

# Twitter
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...

# Home Assistant
HA_URL=http://homeassistant.local:8123
HA_TOKEN=...
```

## Troubleshooting

### Browser automation not working

Playwright browsers are installed in the container. Ensure:

1. The container has enough memory (at least 4GB recommended)
2. Browser skills work correctly in the container environment

### Port conflicts

If ports 3000, 3001, 3002, or 8765 are already in use on your host:

```bash
# Edit docker-compose.yml to change host ports
# Example: Change "3000:3000" to "3001:3000"
```

### Ollama Integration

To use local Ollama with Docker:

1. Uncomment the `ollama` service in `docker-compose.yml`
2. Uncomment the `depends_on` section
3. Set Ollama URL in your `.env`:
   ```bash
   OLLAMA_BASE_URL=http://ollama:11434
   ```
4. Start with: `docker-compose up -d`

## Docker Commands Reference

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f gateway

# Execute command in container
docker-compose exec gateway sh

# Restart specific service
docker-compose restart gateway

# Rebuild images
docker-compose build

# Remove volumes (WARNING: deletes all data!)
docker-compose down -v

# Run onboard wizard (first time only)
docker-compose run --rm gateway node agent.js onboard

# Reset configuration (keeps data volume)
docker-compose run --rm gateway node agent.js onboard --non-interactive
```

## Entrypoint Script

The Docker entrypoint script (`docker-entrypoint.sh`) automatically:

1. **Checks for existing configuration** in the `aura-data` volume
2. **Runs onboard wizard** if configuration is missing and environment variables are set
3. **Creates minimal config** if no environment variables are provided
4. **Starts the server** with the persisted configuration

### Customizing the Entrypoint

You can override the entrypoint in `docker-compose.yml`:

```yaml
services:
  gateway:
    entrypoint: ["/bin/sh", "-c"]
    command: ["node agent.js onboard && node_modules/.bin/tsx src/server.ts"]
```

Or skip the entrypoint entirely:

```bash
docker-compose run --rm gateway node agent.js onboard
docker-compose run --rm gateway node_modules/.bin/tsx src/server.ts
```

## Production Deployment

For production deployment, consider:

1. Use a reverse proxy (nginx, traefik) for SSL/TLS
2. Set proper resource limits in docker-compose.yml
3. Configure external database (optional)
4. Enable monitoring and logging
5. Regular backups of the `aura-data` volume

## Security Notes

- Never commit `.env` file to version control
- Use strong passwords for API keys
- Enable HTTPS in production
- Regularly update Docker images
- Limit container resources as needed
