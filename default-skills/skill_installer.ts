import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

const SKILLS_DIR = path.join(os.homedir(), '.aura', 'skills');

interface SkillDefinition {
  name: string;
  version?: string;
  description?: string;
  executor: string;
  enabled?: boolean;
  source?: 'human' | 'self_written';
  requires_env?: string[];
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
}

function getGitHubToken(): string {
  return process.env.GITHUB_TOKEN || '';
}

function parseRepoUrl(repo: string): { owner: string; repo: string; branch: string; path: string } {
  let owner = '';
  let repoName = '';
  let branch = 'main';
  let pathPrefix = '';

  if (repo.startsWith('https://github.com/')) {
    const match = repo.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/([^\/]+)(?:\/(.*))?)?/);
    if (match) {
      owner = match[1]!;
      repoName = match[2]!.replace(/\.git$/, '');
      branch = match[3] || 'main';
      pathPrefix = match[4] || '';
    }
  } else if (repo.startsWith('https://raw.githubusercontent.com/')) {
    const match = repo.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.*)/);
    if (match) {
      owner = match[1]!;
      repoName = match[2]!;
      branch = match[3]!;
      pathPrefix = match[4]!;
    }
  } else if (repo.includes('/')) {
    const parts = repo.split('/');
    owner = parts[0]!;
    repoName = parts[1]!;
  }

  return { owner, repo: repoName, branch, path: pathPrefix };
}

async function fetchGitHub(url: string, token: string): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AURA-Gateway-Skill-Installer',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.text();
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const text = await fetchGitHub(url, token);
  return JSON.parse(text);
}

async function getDefaultBranch(owner: string, repo: string, token: string): Promise<string> {
  try {
    const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, token) as { default_branch: string };
    return data.default_branch || 'main';
  } catch {
    return 'main';
  }
}

function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

export async function install_skill_from_github(args: {
  repo: string;
  branch?: string;
  skill_path?: string;
}, _ctx: unknown): Promise<unknown> {
  const { repo, branch: inputBranch, skill_path } = args;

  if (!repo) {
    throw new Error('repo is required. Provide either owner/repo or a full GitHub URL.');
  }

  const token = getGitHubToken();
  const { owner, repo: repoName, branch: parsedBranch, path: pathPrefix } = parseRepoUrl(repo);

  if (!owner || !repoName) {
    throw new Error(`Invalid repository format: ${repo}. Use 'owner/repo' or a GitHub URL.`);
  }

  const branch = inputBranch || parsedBranch || await getDefaultBranch(owner, repoName, token);

  console.log(`[SkillInstaller] Fetching repository: ${owner}/${repoName} (branch: ${branch})`);

  const searchPath = skill_path || pathPrefix || '';

  let apiUrl: string;
  let baseRawUrl: string;

  if (searchPath) {
    apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${searchPath}?ref=${branch}`;
    baseRawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${searchPath}`;
  } else {
    apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents?ref=${branch}`;
    baseRawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}`;
  }

  const contents = await fetchJson(apiUrl, token) as Array<{ name: string; type: string; download_url?: string; path?: string }>;

  if (!Array.isArray(contents)) {
    throw new Error('Could not fetch repository contents. The path may not exist.');
  }

  const yamlFiles: Array<{ name: string; path: string; download_url: string }> = [];

  async function findYamlFiles(items: Array<{ name: string; type: string; path?: string; download_url?: string }>, basePath: string): Promise<void> {
    for (const item of items) {
      if (item.type === 'file' && item.name.endsWith('.yaml')) {
        yamlFiles.push({
          name: item.name,
          path: item.path || item.name,
          download_url: item.download_url || `${basePath}/${item.name}`,
        });
      } else if (item.type === 'dir' && searchPath === '') {
        const dirApiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${item.name}?ref=${branch}`;
        const dirContents = await fetchJson(dirApiUrl, token) as Array<{ name: string; type: string; path?: string; download_url?: string }>;
        await findYamlFiles(dirContents, `${basePath}/${item.name}`);
      }
    }
  }

  await findYamlFiles(contents, baseRawUrl);

  if (yamlFiles.length === 0) {
    throw new Error('No skill definition files (.yaml) found in the repository.');
  }

  ensureSkillsDir();

  const installedSkills: Array<{ name: string; version: string; status: string; message: string }> = [];
  const errors: Array<{ file: string; error: string }> = [];

  for (const yamlFile of yamlFiles) {
    try {
      const yamlContent = await fetchGitHub(yamlFile.download_url, token);
      const skillDef = yaml.load(yamlContent) as SkillDefinition;

      if (!skillDef?.name) {
        errors.push({ file: yamlFile.name, error: 'Invalid skill definition: missing name field' });
        continue;
      }

      const executorFileName = skillDef.executor;
      const baseDir = path.dirname(yamlFile.path);
      const executorPathInRepo = baseDir ? `${baseDir}/${executorFileName}` : executorFileName;
      const executorUrl = `${baseRawUrl}/${executorPathInRepo}`;

      const destYamlName = yamlFile.name.split('/').pop() || yamlFile.name;
      const destExecutorName = executorFileName.split('/').pop() || executorFileName;

      const destYamlPath = path.join(SKILLS_DIR, destYamlName);
      const destExecutorPath = path.join(SKILLS_DIR, destExecutorName);

      let yamlContentToSave = yamlContent;

      if (fs.existsSync(destYamlPath)) {
        const existingContent = fs.readFileSync(destYamlPath, 'utf8');
        const existingSkill = yaml.load(existingContent) as SkillDefinition;
        if (existingSkill?.name === skillDef.name) {
          installedSkills.push({
            name: skillDef.name,
            version: skillDef.version || 'unknown',
            status: 'skipped',
            message: `Skill '${skillDef.name}' already installed`,
          });
          continue;
        }

        const newName = `${skillDef.name}_${Date.now().toString(36)}`;
        const newYamlName = destYamlName.replace(skillDef.name, newName);
        const newExecutorName = destExecutorName.replace(skillDef.name, newName);

        yamlContentToSave = yamlContent.replace(
          new RegExp(`^name: ${skillDef.name}`, 'm'),
          `name: ${newName}`
        );
        yamlContentToSave = yamlContentToSave.replace(
          new RegExp(`^executor: ${executorFileName}`, 'm'),
          `executor: ${newExecutorName}`
        );

        fs.writeFileSync(path.join(SKILLS_DIR, newYamlName), yamlContentToSave, 'utf8');

        try {
          const executorContent = await fetchGitHub(executorUrl.replace(executorFileName, newExecutorName), token);
          fs.writeFileSync(path.join(SKILLS_DIR, newExecutorName), executorContent, 'utf8');
        } catch {
          if (fs.existsSync(destExecutorPath)) {
            fs.copyFileSync(destExecutorPath, path.join(SKILLS_DIR, newExecutorName));
          }
        }

        installedSkills.push({
          name: newName,
          version: skillDef.version || 'unknown',
          status: 'installed',
          message: `Installed as '${newName}' to avoid conflict`,
        });
        continue;
      }

      yamlContentToSave = yamlContent.replace(
        new RegExp(`^executor: ${executorFileName}`, 'm'),
        `executor: ${destExecutorName}`
      );

      fs.writeFileSync(destYamlPath, yamlContentToSave, 'utf8');

      try {
        const executorContent = await fetchGitHub(executorUrl, token);
        fs.writeFileSync(destExecutorPath, executorContent, 'utf8');
      } catch {
        errors.push({ file: yamlFile.name, error: `Could not fetch executor: ${executorFileName}` });
        continue;
      }

      installedSkills.push({
        name: skillDef.name,
        version: skillDef.version || 'unknown',
        status: 'installed',
        message: `Successfully installed from ${owner}/${repoName}`,
      });

      console.log(`[SkillInstaller] Installed skill: ${skillDef.name}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push({ file: yamlFile.name, error: errorMsg });
    }
  }

  return {
    success: errors.length === 0,
    repository: `${owner}/${repoName}`,
    branch,
    installed: installedSkills,
    errors: errors.length > 0 ? errors : undefined,
    message: `Installed ${installedSkills.filter(s => s.status === 'installed').length} skill(s) from ${owner}/${repoName}`,
  };
}

export async function list_installed_skills(_args: unknown, _ctx: unknown): Promise<unknown> {
  ensureSkillsDir();

  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.yaml'));
  const skills: Array<{ name: string; version: string; description: string; enabled: boolean; file: string }> = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8');
      const def = yaml.load(content) as SkillDefinition;
      if (def?.name) {
        skills.push({
          name: def.name,
          version: def.version || 'unknown',
          description: def.description || '',
          enabled: def.enabled ?? true,
          file,
        });
      }
    } catch {
      // Skip invalid files
    }
  }

  return {
    total: skills.length,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function remove_installed_skill(args: { skill_name: string }, _ctx: unknown): Promise<unknown> {
  const { skill_name } = args;

  if (!skill_name) {
    throw new Error('skill_name is required');
  }

  ensureSkillsDir();

  const files = fs.readdirSync(SKILLS_DIR);
  const yamlFile = files.find(f => f === `${skill_name}.yaml`);
  const tsFile = files.find(f => f === `${skill_name}.ts`);
  const jsFile = files.find(f => f === `${skill_name}.js`);
  const mjsFile = files.find(f => f === `${skill_name}.mjs`);

  if (!yamlFile) {
    throw new Error(`Skill '${skill_name}' not found`);
  }

  const removed: string[] = [];

  try {
    fs.unlinkSync(path.join(SKILLS_DIR, yamlFile));
    removed.push(yamlFile);
  } catch {
    // Ignore
  }

  for (const executorFile of [tsFile, jsFile, mjsFile]) {
    if (executorFile) {
      try {
        fs.unlinkSync(path.join(SKILLS_DIR, executorFile));
        removed.push(executorFile);
      } catch {
        // Ignore
      }
    }
  }

  console.log(`[SkillInstaller] Removed skill: ${skill_name}`);

  return {
    success: true,
    skill_name,
    removed,
    message: `Skill '${skill_name}' has been removed`,
  };
}

export async function search_github_skills(args: { query: string; per_page?: number }, _ctx: unknown): Promise<unknown> {
  const { query, per_page = 10 } = args;

  if (!query) {
    throw new Error('query is required');
  }

  const token = getGitHubToken();
  const searchQuery = `${query} language:yaml language:typescript`;
  const encodedQuery = encodeURIComponent(searchQuery);

  const url = `https://api.github.com/search/repositories?q=${encodedQuery}&per_page=${per_page}&sort=stars&order=desc`;

  try {
    const data = await fetchJson(url, token) as {
      total_count: number;
      items: Array<{
        full_name: string;
        description: string;
        html_url: string;
        stargazers_count: number;
        forks_count: number;
        updated_at: string;
        language: string;
      }>;
    };

    if (data.total_count === 0) {
      return {
        query,
        total: 0,
        results: [],
        message: 'No repositories found matching your query',
      };
    }

    const results = data.items.map(repo => ({
      name: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      updated: repo.updated_at,
      language: repo.language,
    }));

    return {
      query,
      total: data.total_count,
      results,
      message: `Found ${data.total_count} repositories (showing ${results.length})`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`GitHub search failed: ${errorMsg}`);
  }
}
