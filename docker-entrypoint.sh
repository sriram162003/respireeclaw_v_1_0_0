#!/bin/bash
set -e

# RespireeClaw Gateway Docker Entrypoint
# Checks if onboarding is needed and runs the server

echo "=== RespireeClaw Gateway Docker Entry ==="

# Check if the first argument is a command that should bypass the entrypoint
if [ "$1" = "node" ] && [ "$2" = "agent.js" ] && [ "$3" = "onboard" ]; then
    echo "Running onboard wizard..."
    exec node_modules/.bin/tsx agent.js onboard "${@:4}"
fi

# Check if the first argument is a command that should bypass the entrypoint
if [ "$1" = "node" ] && [ "$2" = "agent.js" ] && [ "$3" = "--daemon" ]; then
    echo "Running daemon..."
    exec node_modules/.bin/tsx agent.js --daemon
fi

# Check if the first argument is a command that should bypass the entrypoint
if [ "$1" = "node" ]; then
    echo "Running command: $@"
    exec node_modules/.bin/tsx "${@:2}"
fi

# Check if configuration exists
AURA_DIR="/root/.aura"
CONFIG_FILE="$AURA_DIR/config.yaml"
AGENTS_FILE="$AURA_DIR/agents.yaml"
KEYS_FILE="$AURA_DIR/keys.yaml"

# If configuration is missing, try non-interactive mode
if [ ! -f "$CONFIG_FILE" ] || [ ! -f "$AGENTS_FILE" ] || [ ! -f "$KEYS_FILE" ]; then
    echo "Configuration not found in $AURA_DIR"
    
    # Check if we have a non-interactive mode (env vars set)
    if [ -n "$AGENT_NAME" ] && [ -n "$LLM_PROVIDER" ]; then
        echo "Non-interactive mode detected. Running onboard wizard..."
        node agent.js onboard --non-interactive
    else
        echo "No configuration found and no environment variables set."
        echo ""
        echo "To configure the gateway, run:"
        echo "  docker-compose run --rm gateway node agent.js onboard"
        echo ""
        echo "Or set these environment variables in docker-compose.yml:"
        echo "  - AGENT_NAME=MyAgent"
        echo "  - LLM_PROVIDER=ollama (or claude, openai, gemini)"
        echo "  - ANTHROPIC_API_KEY=..."
        echo "  - OPENAI_API_KEY=..."
        echo "  - GOOGLE_API_KEY=..."
        echo ""
        echo "Starting with minimal configuration..."
        
        # Create minimal config for first run
        mkdir -p "$AURA_DIR"
        if [ ! -f "$KEYS_FILE" ]; then
            echo "keys: []" > "$KEYS_FILE"
        fi
        if [ ! -f "$CONFIG_FILE" ]; then
            cat > "$CONFIG_FILE" << 'EOF'
agent:
  name: "RespireeClaw"
  persona: "You are RespireeClaw, a helpful AI assistant."

llm:
  default: ollama/llama3.2:3b
  routing:
    simple: ollama/llama3.2:3b
    complex: ollama/llama3.2:3b
    vision: ollama/llama3.2:3b
    creative: ollama/llama3.2:3b
    offline: ollama/llama3.2:3b
  providers:
    ollama:
      base_url: ${OLLAMA_BASE_URL:-http://ollama:11434}
      models: [llama3.2:3b]

channels:
  webchat:
    enabled: true
    port: 3000

voice:
  tts:
    provider: none
  stt:
    provider: whisper_api

canvas:
  enabled: true
  port: 3001

scheduler:
  heartbeat_interval_min: 30
  reminder_check_sec: 60
  nightly_summary_time: "23:30"

security:
  bind_address: 0.0.0.0
  rest_port: 3002
  anp_port: 8765
EOF
        fi
        if [ ! -f "$AGENTS_FILE" ]; then
            cat > "$AGENTS_FILE" << 'EOF'
agents:
  - id: default
    name: "RespireeClaw"
    description: "Default agent"
    persona: "You are RespireeClaw. Be helpful and brief."
    channels: [__default__]
    skills: [web_search, reminders, selenium_testing]
    llm_tier: simple
    memory_ns: default
EOF
        fi
        echo "Minimal configuration created."
    fi
else
    echo "Configuration found. Starting gateway..."
fi

# Sync default skills — copy all skill files from the image into the volume,
# overwriting existing ones so updates to default-skills/ always take effect on rebuild.
DEFAULT_SKILLS_DIR="/app/default-skills"
SKILLS_DIR="$AURA_DIR/skills"
mkdir -p "$SKILLS_DIR"
if [ -d "$DEFAULT_SKILLS_DIR" ]; then
    copied=0
    updated=0
    for src in "$DEFAULT_SKILLS_DIR"/*; do
        fname=$(basename "$src")
        dest="$SKILLS_DIR/$fname"
        if [ ! -f "$dest" ]; then
            cp "$src" "$dest"
            copied=$((copied + 1))
        elif ! cmp -s "$src" "$dest"; then
            cp "$src" "$dest"
            updated=$((updated + 1))
        fi
    done
    [ "$copied" -gt 0 ] && echo "Synced $copied new skill file(s) to $SKILLS_DIR"
    [ "$updated" -gt 0 ] && echo "Updated $updated changed skill file(s) in $SKILLS_DIR"
fi

# Start the server
echo "Starting server..."
exec node_modules/.bin/tsx src/server.ts
