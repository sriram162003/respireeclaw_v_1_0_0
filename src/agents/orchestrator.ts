import crypto from 'crypto';
import type { LLMRouter } from '../llm/router.js';
import type { SkillsEngine } from '../skills/engine.js';
import type { LLMMessage, ToolDefinition } from '../llm/types.js';
import type { SkillContext } from '../skills/types.js';

interface SubAgentSpec {
  role:   string;
  task:   string;
  tools?: string[];
}

interface SubAgentRun {
  id:         string;
  role:       string;
  task:       string;
  status:     'running' | 'done' | 'error';
  result?:    string;
  error?:     string;
  started_at: number;
  done_at?:   number;
  logs:       AgentLog[];
}

interface AgentLog {
  ts:      number;
  type:    'tool' | 'message' | 'error' | 'result';
  role?:   string;
  content: string;
}

interface OrchestratorSession {
  id:         string;
  node_id:    string;
  objective:  string;
  agents:     SubAgentRun[];
  created_at: number;
  status:     'running' | 'done';
  supervisor?: SubAgentRun;
  specs:      SubAgentSpec[];     // stored so fix_agent_error can re-run agents
  extraRuns:  Promise<void>[];    // tracks dynamically spawned agents
  cancelled:  boolean;            // supervisor force-stop signal for workers
}

interface AgentMessage {
  from:    string;
  to:      string;
  content: string;
  ts:      number;
}

const messageBus = new Map<string, AgentMessage[]>();
const agentActivityLog = new Map<string, AgentLog[]>();

const INTERNAL_API_KEY = 'sk-aura-69fc53fbf234e76095e9f0f29e749373';

function notifyDashboard4(type: string, data: Record<string, unknown>): void {
  fetch('http://localhost:3002/dashboard4/api/event', {
    method:  'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${INTERNAL_API_KEY}`
    },
    body:    JSON.stringify({ type, data, ts: Date.now() }),
    signal:  AbortSignal.timeout(2000),
  }).catch(() => { /* non-critical */ });
}

function busPost(sessionId: string, from: string, to: string, content: string): void {
  if (!from || !to) {
    console.warn(`[Orchestrator] busPost skipped — invalid from="${from}" to="${to}"`);
    return;
  }
  const msgs = messageBus.get(sessionId) ?? [];
  msgs.push({ from, to, content, ts: Date.now() });
  messageBus.set(sessionId, msgs);
  console.log(`[Orchestrator] ${from} → ${to}: ${content.slice(0, 80)}`);
  notifyDashboard4('agent_message', { session_id: sessionId, from, to, content, ts: Date.now() });
}

function busBroadcast(sessionId: string, from: string, content: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const agent of session.agents) {
    if (agent.role !== from) {
      busPost(sessionId, from, agent.role, content);
    }
  }
  if (session.supervisor && session.supervisor.role !== from) {
    busPost(sessionId, from, session.supervisor.role, content);
  }
}

function busRead(sessionId: string, role: string): AgentMessage[] {
  return (messageBus.get(sessionId) ?? []).filter(m => m.to === role || m.to === 'all');
}

function logAgentActivity(sessionId: string, role: string, type: AgentLog['type'], content: string): void {
  const logs = agentActivityLog.get(sessionId) ?? [];
  logs.push({ ts: Date.now(), type, role, content });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  agentActivityLog.set(sessionId, logs);
}

function getAllAgentStatuses(sessionId: string): Record<string, { status: string; result?: string; error?: string; logs: AgentLog[] }> {
  const session = sessions.get(sessionId);
  if (!session) return {};
  
  const status: Record<string, { status: string; result?: string; error?: string; logs: AgentLog[] }> = {};
  
  for (const agent of session.agents) {
    status[agent.role] = {
      status: agent.status,
      result: agent.result,
      error: agent.error,
      logs: agent.logs,
    };
  }
  
  if (session.supervisor) {
    status[session.supervisor.role] = {
      status: session.supervisor.status,
      result: session.supervisor.result,
      error: session.supervisor.error,
      logs: session.supervisor.logs,
    };
  }
  
  return status;
}

function getAgentErrors(sessionId: string): Array<{ role: string; error: string; ts: number }> {
  const logs = agentActivityLog.get(sessionId) ?? [];
  return logs
    .filter(l => l.type === 'error')
    .map(l => ({ role: l.role!, error: l.content, ts: l.ts }));
}

function addSessionAgent(sessionId: string, spec: SubAgentSpec): SubAgentRun {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');
  
  const run: SubAgentRun = {
    id: crypto.randomUUID(),
    role: spec.role,
    task: spec.task,
    status: 'running',
    started_at: Date.now(),
    logs: [],
  };
  
  session.agents.push(run);
  notifyDashboard4('agent_spawned', { session_id: sessionId, role: spec.role, task: spec.task });
  
  return run;
}

const COMMS_TOOLS: ToolDefinition[] = [
  {
    name: 'agent_send',
    description: 'Send a message to another agent in this team. Use to share findings, ask for data, or coordinate work.',
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Role of the recipient agent' },
        message: { type: 'string', description: 'The message content to send' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'agent_broadcast',
    description: 'Send a message to ALL agents in the team at once. Use to share important findings with everyone.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message content to broadcast to all agents' },
      },
      required: ['message'],
    },
  },
  {
    name: 'agent_read',
    description: 'Read messages sent to you by other agents or the user. Messages include a "from" field — user messages have from="user".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'notify_user',
    description: 'Send a message directly to the user (the person who created this team). Use this to greet them, share results, ask questions, or send any output meant for the user — NOT other agents.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to the user' },
      },
      required: ['message'],
    },
  },
  {
    name: 'wait_for_user_message',
    description: 'Block and wait until the user sends a message. Always call notify_user first to greet or prompt the user, then call this to wait for their reply. Do NOT declare done before the user responds if your task requires it.',
    parameters: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'Seconds to wait before giving up (default 120, max 600)' },
      },
    },
  },
  {
    name: 'get_team_status',
    description: 'Get the status of all agents in your team. Shows which agents are running, done, or have errors. Use this to monitor progress and identify issues.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_agent_errors',
    description: 'Get all errors that have occurred in the team. Use this to identify what went wrong and decide how to fix it.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'spawn_subagent',
    description: 'Spawn a new sub-agent to handle a specific subtask. Use when you need additional help or when an agent has failed and needs replacement. If no tools specified, inherits all tools from the current team.',
    parameters: {
      type: 'object',
      properties: {
        role:  { type: 'string', description: 'The role/name for the new agent (e.g., researcher, coder, tester)' },
        task:  { type: 'string', description: 'The specific task for this agent to complete' },
        tools: { type: 'array', description: 'Optional skill names - if empty, inherits all team tools', items: { type: 'string' } },
      },
      required: ['role', 'task'],
    },
  },
  {
    name: 'fix_agent_error',
    description: 'Attempt to fix an error that occurred in another agent by re-running their task or taking corrective action.',
    parameters: {
      type: 'object',
      properties: {
        agent_role: { type: 'string', description: 'The role of the agent that had an error' },
        fix_action: { type: 'string', description: 'Describe what action to take to fix the issue' },
      },
      required: ['agent_role', 'fix_action'],
    },
  },
];

const MAX_SUB_AGENT_ITERATIONS = 8;
const MAX_SESSIONS = 20;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per agent

let sessions: Map<string, OrchestratorSession> = new Map();

interface OrchestratorDeps {
  /** Semantic memory search — namespace → query → hits */
  memory?:      { search: (ns: string, q: string) => Promise<string[]> };
  /** Read long-term user profile for a namespace */
  readProfile?: (ns: string) => string;
  /** Read self-knowledge for a namespace */
  readSelf?:    (ns: string) => string;
  /** Resolve a node_id to a human name via contacts.md */
  userLookup?:  (nodeId: string) => { name: string; notes?: string } | null;
  /** Channel send — lets workers notify the triggering user if needed */
  channel?:     { send: (nodeId: string, text: string) => Promise<void> };
  /** Name of this gateway/agent (e.g. "Gary") */
  agentName?:   string;
  /** Default memory namespace for dashboard-spawned sessions */
  defaultMemNs?: string;
}

export class AgentOrchestrator {
  constructor(
    private llm:    LLMRouter,
    private skills: SkillsEngine,
    private deps:   OrchestratorDeps = {},
  ) {}

  getToolDef(): ToolDefinition {
    return {
      name: 'spawn_team',
      description: 'Spawn a team of parallel sub-agents with a supervisor to tackle complex tasks. The supervisor monitors progress, identifies issues, and can spawn new agents or fix errors. Each sub-agent is aware of the overall goal and can communicate with others.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The overall goal for the team' },
          supervisor: { type: 'string', description: 'Role name for the supervisor/manager agent (default: supervisor)', default: 'supervisor' },
          agents: {
            type: 'array',
            description: 'List of sub-agents to spawn in parallel',
            items: {
              type: 'object',
              properties: {
                role:  { type: 'string', description: 'The role of this sub-agent' },
                task:  { type: 'string', description: 'The specific task for this sub-agent' },
                tools: { type: 'array', description: 'Optional skill names', items: { type: 'string' } },
              },
              required: ['role', 'task'],
            },
          },
        },
        required: ['objective', 'agents'],
      },
    };
  }

  private setupSession(objective: string, agentSpecs: SubAgentSpec[], nodeId: string, supervisorRole = 'supervisor'): { session: OrchestratorSession; runs: SubAgentRun[]; sessionId: string; supervisorRun: SubAgentRun } {
    const sessionId = crypto.randomUUID();
    messageBus.set(sessionId, []);
    agentActivityLog.set(sessionId, []);

    const supervisorRun: SubAgentRun = {
      id: crypto.randomUUID(),
      role: supervisorRole,
      task: `Oversee the team working towards: ${objective}. Monitor progress, identify issues, communicate with agents, and fix problems by spawning new agents or taking direct action.`,
      status: 'running',
      started_at: Date.now(),
      logs: [],
    };

    const runs: SubAgentRun[] = agentSpecs.map(spec => ({
      id: crypto.randomUUID(), role: spec.role, task: spec.task,
      status: 'running' as const, started_at: Date.now(), logs: [],
    }));

    const session: OrchestratorSession = {
      id: sessionId, node_id: nodeId, objective,
      agents: runs, supervisor: supervisorRun,
      created_at: Date.now(), status: 'running',
      specs: agentSpecs, extraRuns: [], cancelled: false,
    };

    if (sessions.size >= MAX_SESSIONS) {
      const oldest = Array.from(sessions.entries()).sort(([, a], [, b]) => a.created_at - b.created_at)[0];
      if (oldest) {
        messageBus.delete(oldest[0]);
        agentActivityLog.delete(oldest[0]);
        sessions.delete(oldest[0]);
      }
    }

    sessions.set(sessionId, session);

    notifyDashboard4('session_start', {
      session_id: sessionId, objective, node_id: nodeId,
      supervisor: supervisorRole,
      agents: agentSpecs.map(s => ({ role: s.role, task: s.task, tools: s.tools ?? [] })),
    });

    return { session, runs, sessionId, supervisorRun };
  }

  /** Build a SkillContext for dashboard-spawned sessions (no incoming GatewayEvent). */
  private buildStubCtx(nodeId = 'orchestrator'): SkillContext {
    const ns   = this.deps.defaultMemNs ?? 'default';
    const self = this;
    return {
      node_id:    nodeId,
      session_id: nodeId,
      agent_id:   nodeId,
      memory: {
        search: (q: string) => self.deps.memory?.search(ns, q) ?? Promise.resolve([]),
      },
      channel: {
        send: (nid: string, text?: string) =>
          self.deps.channel?.send(nid, text) ?? Promise.resolve(),
      },
      canvas: { append: () => {}, clear: () => {} },
      llm: {
        complete: async (tier: string, prompt: string, system?: string) => {
          const res = await self.llm.complete(tier, {
            system: system ?? '', messages: [{ role: 'user', content: prompt }], max_tokens: 1024,
          });
          return { text: res.text };
        },
      },
    };
  }

  async spawnTeam(args: Record<string, unknown>, nodeId: string, ctx: SkillContext): Promise<string> {
    const objective = String(args['objective'] ?? '');
    const agentSpecs = (args['agents'] as SubAgentSpec[] | undefined) ?? [];
    const supervisorRole = String(args['supervisor'] ?? 'supervisor');
    const { session, runs, sessionId, supervisorRun } = this.setupSession(objective, agentSpecs, nodeId, supervisorRole);

    await Promise.all([
      ...agentSpecs.map((spec, i) => this.runSubAgent(sessionId, runs[i]!, spec, agentSpecs, ctx, objective)),
      this.runSupervisor(sessionId, supervisorRun, agentSpecs, ctx, objective),
    ]);

    // Drain dynamically spawned agents (handles cascading spawns)
    let drained = 0;
    while (session.extraRuns.length > drained) {
      await Promise.all(session.extraRuns.slice(drained));
      drained = session.extraRuns.length;
    }

    session.status = 'done';
    messageBus.delete(sessionId);
    notifyDashboard4('session_done', { session_id: sessionId });

    const summary = runs.map(r => {
      if (r.status === 'done') return `[${r.role}] ${r.result ?? '(no result)'}`;
      if (r.status === 'error') return `[${r.role}] ERROR: ${r.error ?? 'unknown'}`;
      return `[${r.role}] (incomplete)`;
    }).join('\n\n');

    return `Team objective: ${objective}\n\nResults:\n${summary}`;
  }

  spawnTeamAsync(args: Record<string, unknown>, nodeId: string): string {
    const objective = String(args['objective'] ?? '');
    const agentSpecs = (args['agents'] as SubAgentSpec[] | undefined) ?? [];
    const supervisorRole = String(args['supervisor'] ?? 'supervisor');
    const { session, runs, sessionId, supervisorRun } = this.setupSession(objective, agentSpecs, nodeId, supervisorRole);
    const ctx = this.buildStubCtx(nodeId);

    Promise.all([
      ...agentSpecs.map((spec, i) => this.runSubAgent(sessionId, runs[i]!, spec, agentSpecs, ctx, objective)),
      this.runSupervisor(sessionId, supervisorRun, agentSpecs, ctx, objective),
    ]).then(async () => {
      let drained = 0;
      while (session.extraRuns.length > drained) {
        await Promise.all(session.extraRuns.slice(drained));
        drained = session.extraRuns.length;
      }
      session.status = 'done';
      messageBus.delete(sessionId);
      notifyDashboard4('session_done', { session_id: sessionId });
    }).catch(err => console.error('[Orchestrator] async team error:', err));

    return sessionId;
  }

  private async runSupervisor(
    sessionId: string,
    run: SubAgentRun,
    agentSpecs: SubAgentSpec[],
    ctx: SkillContext,
    objective: string,
  ): Promise<void> {
    notifyDashboard4('agent_start', { session_id: sessionId, role: run.role, task: run.task, is_supervisor: true });

    try {
      const allTools = [...COMMS_TOOLS];
      const peerRoles = agentSpecs.map(s => s.role);

      const system = [
        `You are the SUPERVISOR/Manager of this agent team.`,
        `Overall Objective: ${objective}`,
        '',
        `Your Team: ${peerRoles.join(', ')}`,
        '',
        `Your Responsibilities:`,
        `- Monitor all agents' progress and status using get_team_status`,
        `- Identify errors and issues using get_agent_errors`,
        `- Communicate with agents using agent_send or agent_broadcast`,
        `- Spawn new agents using spawn_subagent when help is needed`,
        `- Fix failed tasks using fix_agent_error`,
        `- Ensure the overall objective is achieved`,
        '',
        `You have access to special tools to oversee and manage the team. Use them proactively to ensure success.`,
        "Be proactive - don't wait for agents to finish, check their status and intervene if needed.",
      ].join('\n');

      const self = this;

      async function handleSupervisorTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (name === 'get_team_status') {
          return getAllAgentStatuses(sessionId);
        }
        if (name === 'get_agent_errors') {
          return { errors: getAgentErrors(sessionId) };
        }
        if (name === 'agent_send') {
          const { to, message } = args as { to: string; message: string };
          busPost(sessionId, run.role, to, message);
          logAgentActivity(sessionId, run.role, 'message', `Sent to ${to}: ${message}`);
          return { sent: true, to };
        }
        if (name === 'agent_broadcast') {
          const { message } = args as { message: string };
          busBroadcast(sessionId, run.role, message);
          logAgentActivity(sessionId, run.role, 'message', `Broadcast: ${message}`);
          return { broadcast: true, to: 'all' };
        }
        if (name === 'spawn_subagent') {
          const { role, task, tools } = args as { role: string; task: string; tools?: string[] };
          if (!role || !task) return { error: 'spawn_subagent requires role and task' };
          const session = sessions.get(sessionId);
          // Inherit tools from supervisor's team if none specified
          const inheritedTools = tools && tools.length > 0
            ? tools
            : agentSpecs.flatMap(s => s.tools ?? []);
          const newRun  = addSessionAgent(sessionId, { role, task, tools: inheritedTools });
          const newSpec: SubAgentSpec = { role, task, tools: inheritedTools };
          const p = self.runSubAgent(sessionId, newRun, newSpec, [...agentSpecs, newSpec], ctx, objective);
          if (session) session.extraRuns.push(p);
          logAgentActivity(sessionId, run.role, 'message', `Spawned new agent: ${role} with ${inheritedTools.length} tools`);
          return { spawned: true, role, task, tools: inheritedTools };
        }
        if (name === 'fix_agent_error') {
          const { agent_role, fix_action } = args as { agent_role: string; fix_action: string };
          const session = sessions.get(sessionId);
          const agent = session?.agents.find(a => a.role === agent_role);
          const spec   = session?.specs.find(s => s.role === agent_role);
          if (agent && spec && session) {
            agent.status  = 'running';
            agent.error   = undefined;
            agent.done_at = undefined;
            const p = self.runSubAgent(sessionId, agent, spec, session.specs, ctx, objective);
            session.extraRuns.push(p);
            logAgentActivity(sessionId, run.role, 'message', `Re-running ${agent_role}: ${fix_action}`);
            return { fixed: true, agent_role, action: fix_action };
          }
          return { error: 'Agent not found' };
        }
        return { error: 'Unknown supervisor tool' };
      }

      let messages: LLMMessage[] = [{
        role: 'user',
        content: `You are the supervisor. Start by checking the status of all agents and monitor their progress. Use get_team_status to see how each agent is doing.`
      }];

      for (let iter = 0; iter < MAX_SUB_AGENT_ITERATIONS * 2; iter++) {
        const response = await this.llm.complete('complex', {
          system, messages,
          tools: allTools.length > 0 ? allTools : undefined,
          max_tokens: 4096,
        });

        if (!response.tool_calls || response.tool_calls.length === 0) {
          if (response.text.toLowerCase().includes('done') || response.text.toLowerCase().includes('complete')) {
            run.status = 'done';
            run.result = response.text;
            run.done_at = Date.now();
            const s = sessions.get(sessionId);
            if (s) s.cancelled = true; // signal workers to stop
            notifyDashboard4('agent_done', { session_id: sessionId, role: run.role, result: response.text, is_supervisor: true });
            return;
          }
          messages.push({ role: 'assistant', content: response.text });
          messages.push({ role: 'user', content: 'Continue monitoring. Use get_team_status to check agent progress.' });
          continue;
        }

        messages = [...messages, { role: 'assistant' as const, content: response.text || '', tool_calls: response.tool_calls }];

        // Run supervisor tool calls concurrently
        const svToolResults = await Promise.all(
          response.tool_calls.map(async call => {
            let result: unknown;
            try {
              result = await handleSupervisorTool(call.name, call.args as Record<string, unknown>);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              result = { error: true, message: errMsg, tool: call.name };
            }
            return { role: 'tool' as const, content: JSON.stringify(result), tool_call_id: call.id };
          })
        );
        messages = [...messages, ...svToolResults];

        const session = sessions.get(sessionId);
        if (session && session.agents.every(a => a.status !== 'running')) {
          run.status = 'done';
          run.result = 'All agents completed. Objective achieved.';
          run.done_at = Date.now();
          session.cancelled = true; // signal any remaining workers to stop
          notifyDashboard4('agent_done', { session_id: sessionId, role: run.role, result: run.result, is_supervisor: true });
          return;
        }
      }

      run.status = 'done';
      run.result = 'Supervision complete - max iterations reached';
      run.done_at = Date.now();
      notifyDashboard4('agent_done', { session_id: sessionId, role: run.role, result: run.result, is_supervisor: true });

    } catch (err) {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
      run.done_at = Date.now();
      notifyDashboard4('agent_error', { session_id: sessionId, role: run.role, error: run.error, is_supervisor: true });
    }
  }

  private async runSubAgent(
    sessionId: string,
    run: SubAgentRun,
    spec: SubAgentSpec,
    allSpecs: SubAgentSpec[],
    ctx: SkillContext,
    objective: string,
  ): Promise<void> {
    if (!spec.role || !spec.task) {
      console.warn(`[Orchestrator] runSubAgent skipped — missing role="${spec.role}" task="${spec.task}"`);
      run.status = 'error';
      run.error  = `Invalid spec: role="${spec.role}" task="${spec.task}"`;
      return;
    }
    notifyDashboard4('agent_start', { session_id: sessionId, role: spec.role, task: spec.task });

    try {
      const skillTools = this.skills.getToolDefs(spec.tools ?? []);
      const rawTools = [...skillTools, ...COMMS_TOOLS];

      const seen = new Set<string>();
      const allTools = rawTools.filter(t => {
        if (seen.has(t.name)) return false;
        seen.add(t.name); return true;
      });

      const peers = allSpecs.filter(s => s.role !== spec.role).map(s => s.role);

      // Resolve user identity and profile from deps
      const session       = sessions.get(sessionId);
      const ns            = this.deps.defaultMemNs ?? 'default';
      const userInfo      = session ? this.deps.userLookup?.(session.node_id) : null;
      const userName      = userInfo?.name ?? null;
      const userProfile   = this.deps.readProfile?.(ns)?.trim() ?? '';
      const selfKnowledge = this.deps.readSelf?.(ns)?.trim() ?? '';
      const agentName     = this.deps.agentName ?? 'the gateway';

      // Search memory once at task start — relevant context for this task only
      const memQuery = userName ? `${spec.task} ${userName}` : spec.task;
      const memHits  = await ctx.memory.search(memQuery).catch(() => [] as string[]);

      const toolList = allTools.length > 0
        ? '\nAVAILABLE TOOLS:\n' + allTools.map(t => `- ${t.name}: ${t.description}`) .join('\n')
          + '\nWhen tool calls are independent, call them all in one response. Only sequence when a later call depends on an earlier result.'
        : '';

      const systemParts = [
        `You are a sub-agent of ${agentName}, acting as: ${spec.role}.`,
        `Your task: ${spec.task}`,
        `Team objective: ${objective}`,
        `Current time: ${new Date().toISOString()}`,
      ];

      if (userName) {
        systemParts.push(`You are working for: ${userName}${userInfo?.notes ? ` (${userInfo.notes})` : ''}`);
      }
      if (userProfile) {
        systemParts.push(`What we know about the user: ${userProfile.slice(0, 600)}`);
      }
      if (selfKnowledge) {
        systemParts.push(`What ${agentName} knows about itself: ${selfKnowledge.slice(0, 400)}`);
      }
      if (memHits.length > 0) {
        systemParts.push(`Relevant memory:\n${memHits.join('\n')}`);
      }
      if (toolList) systemParts.push(toolList);
      systemParts.push(
        peers.length > 0
          ? `Team: ${peers.join(', ')}. Use agent_send/agent_broadcast to share findings with teammates, agent_read to check incoming messages.`
          : 'You are the sole agent in this session.',
      );
      systemParts.push(
        'To send a message to the USER (the human), use notify_user — do NOT use agent_send for this.',
        'If your task requires waiting for the user to reply, call notify_user first, then call wait_for_user_message.',
        'Only return a final result (declare done) when your task is truly complete.',
      );

      const system = systemParts.join('\n');

      logAgentActivity(sessionId, spec.role, 'message', `Started with task: ${spec.task}`);

      // Detect if task requires user interaction — affects how we handle text-only responses
      const WAIT_KEYWORDS = ['wait', 'greet', 'respond', 'reply', 'introduce', 'say hi', 'say hello', 'message the user'];
      const taskNeedsUserInteraction = WAIT_KEYWORDS.some(kw => spec.task.toLowerCase().includes(kw));

      // Build an explicit initial message that tells the agent to use tools
      const initialMsg = taskNeedsUserInteraction
        ? `${spec.task}\n\nIMPORTANT: You must use tools to complete this task:\n1. Call notify_user to send your message to the user.\n2. Call wait_for_user_message to pause until they reply.\n3. Only after receiving their reply, return your final result.`
        : spec.task;

      const self = this;
      async function agentLoop(): Promise<void> {
        let messages: LLMMessage[] = [{ role: 'user', content: initialMsg }];
        let calledNotifyUser = false;

        for (let iter = 0; iter < MAX_SUB_AGENT_ITERATIONS; iter++) {
          // Stop early if supervisor declared objective complete
          const session = sessions.get(sessionId);
          if (session?.cancelled) break;

          const response = await self.llm.complete('complex', {
            system, messages,
            tools: allTools.length > 0 ? allTools : undefined,
            max_tokens: 8192,
          });

          if (!response.tool_calls || response.tool_calls.length === 0) {
            // If task needs user interaction and agent hasn't notified the user yet,
            // push back instead of declaring done
            if (taskNeedsUserInteraction && !calledNotifyUser) {
              messages = [
                ...messages,
                { role: 'assistant' as const, content: response.text || '' },
                { role: 'user' as const, content: 'You must call notify_user to send your message to the user before declaring done. Use the tool now.' },
              ];
              continue;
            }
            run.status  = 'done';
            run.result  = response.text;
            run.done_at = Date.now();
            logAgentActivity(sessionId, spec.role, 'result', response.text.slice(0, 200));
            notifyDashboard4('agent_done', { session_id: sessionId, role: spec.role, result: response.text });
            return;
          }

          messages = [...messages, { role: 'assistant' as const, content: response.text || '', tool_calls: response.tool_calls }];

          // Execute all tool calls concurrently
          const toolResults = await Promise.all(
            response.tool_calls.map(async call => {
              let result: unknown;
              try {
                if (call.name === 'notify_user') {
                  const { message } = call.args as { message: string };
                  const sess = sessions.get(sessionId);
                  // Send to actual channel only for non-dashboard sessions
                  const nodeId = sess?.node_id;
                  if (nodeId && nodeId !== 'dashboard4' && self.deps.channel) {
                    await self.deps.channel.send(nodeId, `[${spec.role}] ${message}`).catch(() => {});
                  }
                  logAgentActivity(sessionId, spec.role, 'message', `→ user: ${message}`);
                  // Always post to dashboard Messages panel
                  notifyDashboard4('agent_message', { session_id: sessionId, from: spec.role, to: 'user', content: message, ts: Date.now() });
                  calledNotifyUser = true;
                  result = { sent: true, to: 'user' };
                } else if (call.name === 'agent_send') {
                  const { to, message } = call.args as { to: string; message: string };
                  busPost(sessionId, spec.role, to, message);
                  logAgentActivity(sessionId, spec.role, 'message', `Sent to ${to}: ${message}`);
                  result = { sent: true, to, from: spec.role };
                } else if (call.name === 'agent_broadcast') {
                  const { message } = call.args as { message: string };
                  busBroadcast(sessionId, spec.role, message);
                  logAgentActivity(sessionId, spec.role, 'message', `Broadcast: ${message}`);
                  result = { broadcast: true };
                } else if (call.name === 'agent_read') {
                  const msgs = busRead(sessionId, spec.role);
                  result = msgs.length > 0
                    ? { messages: msgs.map(m => ({ from: m.from, content: m.content })) }
                    : { messages: [], note: 'No messages yet.' };
                } else if (call.name === 'get_team_status') {
                  result = getAllAgentStatuses(sessionId);
                } else if (call.name === 'get_agent_errors') {
                  result = { errors: getAgentErrors(sessionId) };
                } else if (call.name === 'wait_for_user_message') {
                  const timeoutSecs = Math.min(Number((call.args as Record<string, unknown>).timeout_seconds ?? 120), 600);
                  const waitStartTs = Date.now(); // only catch messages AFTER this point
                  const deadline    = waitStartTs + timeoutSecs * 1000;
                  notifyDashboard4('tool_call', { session_id: sessionId, role: spec.role, tool: 'wait_for_user_message', args_summary: `timeout=${timeoutSecs}s` });
                  logAgentActivity(sessionId, spec.role, 'tool', `Waiting for user message (${timeoutSecs}s)`);
                  let userMsg: AgentMessage | undefined;
                  while (Date.now() < deadline) {
                    if (sessions.get(sessionId)?.cancelled) break;
                    const incoming = busRead(sessionId, spec.role);
                    // Only accept messages that arrived after we started waiting
                    userMsg = incoming.find(m => m.from === 'user' && m.ts >= waitStartTs);
                    if (userMsg) break;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                  }
                  result = userMsg
                    ? { received: true, from: 'user', message: userMsg.content }
                    : { received: false, timed_out: true, waited_seconds: timeoutSecs };
                } else if (call.name === 'spawn_subagent' || call.name === 'fix_agent_error') {
                  result = { note: 'Sub-agent spawning is handled by the supervisor. Continue with your task.' };
                } else {
                  const argsSummary = JSON.stringify(call.args).slice(0, 120);
                  notifyDashboard4('tool_call', { session_id: sessionId, role: spec.role, tool: call.name, args_summary: argsSummary });
                  logAgentActivity(sessionId, spec.role, 'tool', `${call.name}: ${argsSummary}`);
                  result = await self.skills.execute(call.name, call.args as Record<string, unknown>, ctx);
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logAgentActivity(sessionId, spec.role, 'error', `${call.name}: ${errMsg}`);
                result = { error: true, message: errMsg, tool: call.name };
              }
              return { role: 'tool' as const, content: JSON.stringify(result), tool_call_id: call.id };
            })
          );
          messages = [...messages, ...toolResults];
        }

        const last = messages[messages.length - 1];
        run.status  = 'done';
        run.result  = last?.content ?? '(max iterations reached)';
        run.done_at = Date.now();
        logAgentActivity(sessionId, spec.role, 'result', run.result.slice(0, 200));
        notifyDashboard4('agent_done', { session_id: sessionId, role: spec.role, result: run.result });
      }

      // Wall-clock timeout wrapper
      await Promise.race([
        agentLoop(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent "${spec.role}" timed out after ${AGENT_TIMEOUT_MS / 1000}s`)), AGENT_TIMEOUT_MS)
        ),
      ]);

    } catch (err) {
      run.status  = 'error';
      run.error   = err instanceof Error ? err.message : String(err);
      run.done_at = Date.now();
      logAgentActivity(sessionId, spec.role, 'error', run.error);
      notifyDashboard4('agent_error', { session_id: sessionId, role: spec.role, error: run.error });
      // Auto-notify supervisor so it can intervene without polling
      busPost(sessionId, spec.role, 'supervisor', `Agent "${spec.role}" failed: ${run.error}`);
    }
  }

  getSessions(): OrchestratorSession[] {
    return Array.from(sessions.values()).sort((a, b) => b.created_at - a.created_at);
  }

  getSession(sessionId: string): OrchestratorSession | undefined {
    return sessions.get(sessionId);
  }

  /**
   * Inject a message from outside (e.g. the user via dashboard) into
   * the session's message bus so agents receive it on their next agent_read.
   */
  injectMessage(sessionId: string, from: string, to: string, content: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    busPost(sessionId, from, to, content);
    return true;
  }
}
