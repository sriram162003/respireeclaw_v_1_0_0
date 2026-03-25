// Action1 RMM skill - Full integration with Action1 API
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.aura', 'config');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'action1.json');

const BASE_URL = 'https://app.action1.com/api/3.0';

interface Action1Credentials {
  api_key: string;
  api_secret: string;
}

interface Action1Config {
  credentials: Action1Credentials;
  token?: string;
  token_expiry?: number;
}

function loadConfig(): Action1Config | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveConfig(config: Action1Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(config, null, 2));
}

async function action1ApiCall(
  endpoint: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: Record<string, unknown>
): Promise<unknown> {
  const config = loadConfig();
  if (!config?.credentials?.api_key || !config?.credentials?.api_secret) {
    throw new Error('Action1 credentials not configured. Use set_action1_credentials first.');
  }

  // For now, we'll use basic auth with API key as username and secret as password
  // Action1 may use different auth - let's try API key in header
  const auth = Buffer.from(`${config.credentials.api_key}:${config.credentials.api_secret}`).toString('base64');

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };

  if (body && (method === 'POST' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Action1 API error ${response.status}: ${errorText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { raw: await response.text() };
}

export async function set_action1_credentials(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const api_key = String(args['api_key'] || '').trim();
  const api_secret = String(args['api_secret'] || '').trim();

  if (!api_key) throw new Error('api_key is required');
  if (!api_secret) throw new Error('api_secret is required');

  const config: Action1Config = {
    credentials: { api_key, api_secret },
  };

  // Try to validate credentials by making a test call
  try {
    await action1ApiCall('/organizations', 'GET');
    saveConfig(config);
    return {
      success: true,
      message: 'Action1 credentials configured and validated successfully.',
      note: 'Credentials saved to ~/.aura/config/action1.json'
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Still save credentials - user can test with action1_status
    saveConfig(config);
    return {
      success: true,
      message: 'Credentials saved but could not validate. Use action1_status to test.',
      error: msg,
      note: 'Saved to ~/.aura/config/action1.json'
    };
  }
}

export async function action1_status(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const config = loadConfig();
  if (!config?.credentials) {
    return {
      configured: false,
      message: 'No Action1 credentials found. Use set_action1_credentials first.',
    };
  }

  try {
    const result = await action1ApiCall('/organizations', 'GET') as Record<string, unknown>;
    return {
      configured: true,
      connected: true,
      message: 'Successfully connected to Action1 API.',
      organizations: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      configured: true,
      connected: false,
      error: msg,
      message: 'Failed to connect. Check credentials with set_action1_credentials.',
    };
  }
}

export async function list_organizations(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  try {
    const result = await action1ApiCall('/organizations', 'GET') as Record<string, unknown>;
    
    // Handle Action1's response format
    let orgs = result;
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r['results'])) {
        orgs = r['results'];
      } else if (Array.isArray(r['data'])) {
        orgs = r['data'];
      } else if (Array.isArray(r['organizations'])) {
        orgs = r['organizations'];
      }
    }

    return {
      organizations: Array.isArray(orgs) ? orgs : [orgs],
      count: Array.isArray(orgs) ? orgs.length : 1,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list organizations: ${msg}`);
  }
}

export async function list_endpoints(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const organization_id = args['organization_id'] as string | undefined;
  const status = (args['status'] as string) || 'all';
  const limit = Number(args['limit']) || 50;

  let endpoint = '/endpoints';
  const params: string[] = [];
  
  if (organization_id) params.push(`organization_id=${organization_id}`);
  if (status !== 'all') params.push(`status=${status}`);
  if (limit) params.push(`limit=${limit}`);
  
  if (params.length > 0) endpoint += '?' + params.join('&');

  try {
    const result = await action1ApiCall(endpoint, 'GET') as Record<string, unknown>;
    
    let endpoints = result;
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r['results'])) {
        endpoints = r['results'];
      } else if (Array.isArray(r['data'])) {
        endpoints = r['data'];
      } else if (Array.isArray(r['endpoints'])) {
        endpoints = r['endpoints'];
      }
    }

    const endpointList = Array.isArray(endpoints) ? endpoints : [endpoints];
    
    // Add online/offline status info
    const enriched = endpointList.map((ep: unknown) => {
      const e = ep as Record<string, unknown>;
      return {
        id: e['id'] || e['endpoint_id'],
        name: e['name'] || e['computer_name'],
        hostname: e['hostname'],
        os: e['os'] || e['operating_system'],
        status: e['status'] || (e['online'] ? 'online' : 'offline'),
        last_seen: e['last_seen'] || e['last_contact'],
        organization_id: e['organization_id'],
      };
    });

    return {
      endpoints: enriched,
      count: enriched.length,
      filters: { organization_id, status },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list endpoints: ${msg}`);
  }
}

export async function get_endpoint_details(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string;
  if (!endpoint_id) throw new Error('endpoint_id is required');

  try {
    const result = await action1ApiCall(`/endpoints/${endpoint_id}`, 'GET') as Record<string, unknown>;
    
    const ep = result as Record<string, unknown>;
    
    return {
      endpoint_id: ep['id'] || endpoint_id,
      name: ep['name'] || ep['computer_name'],
      hostname: ep['hostname'],
      os: ep['os'] || ep['operating_system'],
      os_version: ep['os_version'],
      status: ep['status'],
      last_seen: ep['last_seen'] || ep['last_contact'],
      ip_address: ep['ip_address'] || ep['ip'],
      mac_address: ep['mac_address'] || ep['mac'],
      organization_id: ep['organization_id'],
      hardware: {
        manufacturer: ep['manufacturer'],
        model: ep['model'],
        cpu: ep['cpu'],
        ram: ep['ram'] || ep['memory'],
        disk_space: ep['disk_space'],
      },
      agent_version: ep['agent_version'],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get endpoint details: ${msg}`);
  }
}

export async function get_endpoint_patches(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string;
  const severity = (args['severity'] as string) || 'all';
  
  if (!endpoint_id) throw new Error('endpoint_id is required');

  let endpoint = `/endpoints/${endpoint_id}/patches`;
  if (severity !== 'all') endpoint += `?severity=${severity}`;

  try {
    const result = await action1ApiCall(endpoint, 'GET') as Record<string, unknown>;
    
    let patches = result;
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r['results'])) {
        patches = r['results'];
      } else if (Array.isArray(r['data'])) {
        patches = r['data'];
      } else if (Array.isArray(r['patches'])) {
        patches = r['patches'];
      } else if (Array.isArray(r['missing_patches'])) {
        patches = r['missing_patches'];
      }
    }

    const patchList = Array.isArray(patches) ? patches : [patches];
    
    // Enrich patch info
    const enriched = patchList.map((p: unknown) => {
      const patch = p as Record<string, unknown>;
      return {
        id: patch['id'] || patch['kb_id'] || patch['patch_id'],
        name: patch['name'] || patch['title'],
        severity: patch['severity'] || patch['importance'],
        description: patch['description'],
        release_date: patch['release_date'] || patch['published'],
        installed: patch['installed'] || false,
      };
    });

    return {
      endpoint_id,
      patches: enriched,
      count: enriched.length,
      summary: {
        critical: enriched.filter((p: { severity: string }) => p.severity?.toLowerCase() === 'critical').length,
        important: enriched.filter((p: { severity: string }) => p.severity?.toLowerCase() === 'important').length,
        moderate: enriched.filter((p: { severity: string }) => p.severity?.toLowerCase() === 'moderate').length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get endpoint patches: ${msg}`);
  }
}

export async function install_endpoint_patches(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string;
  const patch_ids = args['patch_ids'] as string[] | undefined;
  const reboot = Boolean(args['reboot']);

  if (!endpoint_id) throw new Error('endpoint_id is required');

  const body: Record<string, unknown> = {
    endpoint_id,
  };

  if (patch_ids && patch_ids.length > 0) {
    body['patch_ids'] = patch_ids;
  }

  if (reboot) {
    body['reboot'] = true;
  }

  try {
    const result = await action1ApiCall('/patches/install', 'POST', body) as Record<string, unknown>;
    
    return {
      success: true,
      endpoint_id,
      patches_requested: patch_ids?.length || 'all',
      reboot,
      result,
      message: patch_ids?.length 
        ? `Installing ${patch_ids.length} patches on ${endpoint_id}` 
        : `Installing all missing patches on ${endpoint_id}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install patches: ${msg}`);
  }
}

export async function run_script_on_endpoint(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string;
  const script = args['script'] as string;
  const script_type = (args['script_type'] as string) || 'powershell';
  const timeout = Number(args['timeout']) || 60;

  if (!endpoint_id) throw new Error('endpoint_id is required');
  if (!script) throw new Error('script is required');

  const body = {
    endpoint_id,
    script,
    script_type: script_type === 'batch' ? 'batch' : 'powershell',
    timeout,
  };

  try {
    const result = await action1ApiCall('/scripts/execute', 'POST', body) as Record<string, unknown>;
    
    const sr = result as Record<string, unknown>;
    
    return {
      success: true,
      execution_id: sr['execution_id'] || sr['id'],
      endpoint_id,
      status: sr['status'] || 'executed',
      output: sr['output'] || sr['result'] || sr['stdout'],
      error: sr['error'] || sr['stderr'],
      exit_code: sr['exit_code'] || sr['exitCode'],
      message: `Script executed on endpoint ${endpoint_id}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run script: ${msg}`);
  }
}

export async function run_script_on_endpoints(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_ids = args['endpoint_ids'] as string[];
  const script = args['script'] as string;
  const script_type = (args['script_type'] as string) || 'powershell';
  const timeout = Number(args['timeout']) || 60;

  if (!endpoint_ids || endpoint_ids.length === 0) throw new Error('endpoint_ids array is required');
  if (!script) throw new Error('script is required');

  const body = {
    endpoint_ids,
    script,
    script_type: script_type === 'batch' ? 'batch' : 'powershell',
    timeout,
  };

  try {
    const result = await action1ApiCall('/scripts/execute/bulk', 'POST', body) as Record<string, unknown>;
    
    const sr = result as Record<string, unknown>;
    
    return {
      success: true,
      execution_id: sr['execution_id'] || sr['id'],
      target_count: endpoint_ids.length,
      status: sr['status'] || 'executed',
      results: sr['results'] || sr['executions'],
      message: `Script executing on ${endpoint_ids.length} endpoints`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run scripts: ${msg}`);
  }
}

export async function get_vulnerabilities(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string | undefined;
  const severity = (args['severity'] as string) || 'all';
  const status = (args['status'] as string) || 'all';
  const limit = Number(args['limit']) || 50;

  let endpoint = '/vulnerabilities';
  const params: string[] = [];
  
  if (endpoint_id) params.push(`endpoint_id=${endpoint_id}`);
  if (severity !== 'all') params.push(`severity=${severity}`);
  if (status !== 'all') params.push(`status=${status}`);
  if (limit) params.push(`limit=${limit}`);
  
  if (params.length > 0) endpoint += '?' + params.join('&');

  try {
    const result = await action1ApiCall(endpoint, 'GET') as Record<string, unknown>;
    
    let vulns = result;
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r['results'])) {
        vulns = r['results'];
      } else if (Array.isArray(r['data'])) {
        vulns = r['data'];
      } else if (Array.isArray(r['vulnerabilities'])) {
        vulns = r['vulnerabilities'];
      }
    }

    const vulnList = Array.isArray(vulns) ? vulns : [vulns];
    
    const enriched = vulnList.map((v: unknown) => {
      const vuln = v as Record<string, unknown>;
      return {
        id: vuln['id'] || vuln['vulnerability_id'],
        cve_id: vuln['cve_id'] || vuln['cve'],
        title: vuln['title'] || vuln['name'],
        description: vuln['description'],
        severity: vuln['severity'] || vuln['cvss'],
        cvss_score: vuln['cvss_score'] || vuln['cvss'],
        endpoint_id: vuln['endpoint_id'] || vuln['host_id'],
        status: vuln['status'] || 'open',
        published_date: vuln['published_date'] || vuln['published'],
      };
    });

    return {
      vulnerabilities: enriched,
      count: enriched.length,
      filters: { endpoint_id, severity, status },
      summary: {
        critical: enriched.filter((v: { severity: string }) => v.severity?.toLowerCase() === 'critical').length,
        high: enriched.filter((v: { severity: string }) => v.severity?.toLowerCase() === 'high').length,
        medium: enriched.filter((v: { severity: string }) => v.severity?.toLowerCase() === 'medium').length,
        low: enriched.filter((v: { severity: string }) => v.severity?.toLowerCase() === 'low').length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get vulnerabilities: ${msg}`);
  }
}

export async function remediate_vulnerability(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const vulnerability_id = args['vulnerability_id'] as string;
  const action = args['action'] as string;
  const endpoint_id = args['endpoint_id'] as string;

  if (!vulnerability_id) throw new Error('vulnerability_id is required');
  if (!action) throw new Error('action is required (patch, ignore, or schedule)');
  if (!['patch', 'ignore', 'schedule'].includes(action)) {
    throw new Error('action must be one of: patch, ignore, schedule');
  }

  const body = {
    vulnerability_id,
    action,
    ...(endpoint_id && { endpoint_id }),
  };

  try {
    const result = await action1ApiCall('/vulnerabilities/remediate', 'POST', body) as Record<string, unknown>;
    
    return {
      success: true,
      vulnerability_id,
      action,
      result,
      message: `Vulnerability ${vulnerability_id} marked for ${action}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to remediate vulnerability: ${msg}`);
  }
}

export async function list_software(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string | undefined;
  const organization_id = args['organization_id'] as string | undefined;
  const search = args['search'] as string | undefined;

  let endpoint = '/software';
  const params: string[] = [];
  
  if (endpoint_id) params.push(`endpoint_id=${endpoint_id}`);
  if (organization_id) params.push(`organization_id=${organization_id}`);
  if (search) params.push(`search=${encodeURIComponent(search)}`);
  
  if (params.length > 0) endpoint += '?' + params.join('&');

  try {
    const result = await action1ApiCall(endpoint, 'GET') as Record<string, unknown>;
    
    let software = result;
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r['results'])) {
        software = r['results'];
      } else if (Array.isArray(r['data'])) {
        software = r['data'];
      } else if (Array.isArray(r['software'])) {
        software = r['software'];
      }
    }

    const swList = Array.isArray(software) ? software : [software];
    
    const enriched = swList.map((s: unknown) => {
      const sw = s as Record<string, unknown>;
      return {
        name: sw['name'] || sw['software_name'],
        version: sw['version'],
        publisher: sw['publisher'] || sw['vendor'],
        install_date: sw['install_date'] || sw['installed_on'],
        endpoint_id: sw['endpoint_id'],
      };
    });

    return {
      software: enriched,
      count: enriched.length,
      filters: { endpoint_id, organization_id, search },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list software: ${msg}`);
  }
}

export async function deploy_software(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const package_name = args['package_name'] as string;
  const endpoint_ids = args['endpoint_ids'] as string[] | undefined;
  const organization_id = args['organization_id'] as string | undefined;
  const install_params = args['install_params'] as string | undefined;

  if (!package_name) throw new Error('package_name is required');

  const body: Record<string, unknown> = {
    package_name,
  };

  if (endpoint_ids && endpoint_ids.length > 0) {
    body['endpoint_ids'] = endpoint_ids;
  }
  if (organization_id) {
    body['organization_id'] = organization_id;
  }
  if (install_params) {
    body['install_params'] = install_params;
  }

  try {
    const result = await action1ApiCall('/software/deploy', 'POST', body) as Record<string, unknown>;
    
    return {
      success: true,
      deployment_id: result['deployment_id'] || result['id'],
      package_name,
      target: endpoint_ids ? `${endpoint_ids.length} endpoints` : (organization_id ? `organization ${organization_id}` : 'unspecified'),
      result,
      message: `Software deployment initiated for ${package_name}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to deploy software: ${msg}`);
  }
}

export async function restart_endpoint(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const endpoint_id = args['endpoint_id'] as string;
  const action = (args['action'] as string) || 'restart';

  if (!endpoint_id) throw new Error('endpoint_id is required');
  if (!['restart', 'shutdown'].includes(action)) {
    throw new Error('action must be restart or shutdown');
  }

  const body = {
    endpoint_id,
    action,
  };

  try {
    const result = await action1ApiCall('/endpoints/restart', 'POST', body) as Record<string, unknown>;
    
    return {
      success: true,
      endpoint_id,
      action,
      result,
      message: `${action === 'restart' ? 'Restart' : 'Shutdown'} initiated for ${endpoint_id}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to restart endpoint: ${msg}`);
  }
}

export async function get_reports(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const report_type = (args['report_type'] as string) || 'all';
  const organization_id = args['organization_id'] as string | undefined;
  const date_range = (args['date_range'] as string) || 'last_30_days';

  const endpoint = '/reports';
  const params: string[] = [];
  
  if (report_type !== 'all') params.push(`type=${report_type}`);
  if (organization_id) params.push(`organization_id=${organization_id}`);
  if (date_range) params.push(`date_range=${date_range}`);

  const url = params.length > 0 ? `${endpoint}?${params.join('&')}` : endpoint;

  try {
    const result = await action1ApiCall(url, 'GET') as Record<string, unknown>;
    
    return {
      report_type,
      organization_id,
      date_range,
      data: result,
      message: `Retrieved ${report_type} report`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get reports: ${msg}`);
  }
}
