RespireeClaw Gateway
====================

Installation
------------

1. Extract this zip file to a permanent location
2. Run the installer:
   - Windows: Double-click INSTALL.bat
   - macOS/Linux: bash INSTALL.sh

3. Follow the onboard wizard prompts

Quick Start
-----------

After installation:

    # Start the server
    node agent.js --daemon

    # Check status
    node agent.js status

    # View logs
    node agent.js logs

    # Stop the server
    node agent.js stop

Configuration
-------------

Configuration files are stored in ~/.aura/:
- config.yaml - Main settings
- agents.yaml - Agent definitions
- skills/ - Installed skills

Requirements
------------

- Node.js 20+
- npm

See README.md for full documentation.

Docker / EC2 Deployment
-----------------------

1. Edit docker-compose.yml and set your master API key:
       AURA_API_KEY=your-secure-password-here
   Also add your LLM provider key (e.g. ANTHROPIC_API_KEY=sk-ant-...)

2. Open these ports in your EC2 Security Group (inbound):
       3002  - PRIMARY: WebChat UI, REST API, all Dashboards (required)
       3001  - Canvas WebSocket (optional, for canvas panel)
       3000  - Legacy WebChat WebSocket (optional)
       8765  - ANP (optional)

3. Start with Docker Compose:
       docker compose up --build -d

4. Access everything at port 3002:
       WebChat UI  →  http://<your-ec2-ip>:3002/chat
       Dashboard   →  http://<your-ec2-ip>:3002/dashboard
       Dashboard2  →  http://<your-ec2-ip>:3002/dashboard2
       Dashboard3  →  http://<your-ec2-ip>:3002/dashboard3
       Dashboard4  →  http://<your-ec2-ip>:3002/dashboard4

   When the login prompt appears, enter your AURA_API_KEY value.
