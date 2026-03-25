# RespireeClaw Gateway Dockerfile
FROM node:20-slim

# Install system dependencies for native modules and browser automation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    chromium \
    chromium-driver \
    fontconfig \
    libnss3 \
    libnspr4 \
    libasound2 \
    libgbm1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libpango-1.0-0 \
    libcairo2 \
    libavahi-compat-libdnssd-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (include dev dependencies for tsx)
RUN npm ci --include=dev

# Rebuild native modules for Debian
RUN npm rebuild

# Copy application source
COPY . .

# Create .env file with defaults
RUN touch .env

# Create Aura directory for config/data
RUN mkdir -p /root/.aura

# Expose ports
EXPOSE 3000 3001 3002 8765

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })" || exit 1

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Run the gateway
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
