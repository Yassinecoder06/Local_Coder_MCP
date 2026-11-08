const token = 'lc_demo_7f3c9a2e1b';
const status = {
  version: '1.0.0',
  uptimeSec: 3840,
  authMode: 'both',
  toolProfile: 'essential',
  approvalMode: 'minimal',
  sessions: 1,
  workspaceRoots: ['/workspace/demo', '/workspace/another-project'],
  defaultWorkspace: '/workspace/demo',
  endpoints: {
    local: 'http://localhost:8787',
    public: null,
    mcpUrlWithToken: `http://localhost:8787/mcp/${token}`,
    oauthIssuer: '',
  },
  integrations: {
    herdr: {
      available: false,
      detail: 'herdr is not installed in this container.',
    },
    browser: {
      available: true,
      detail: 'Browser checks are ready.',
    },
  },
};
const connect = {
  token,
  chatgpt: {
    url: `http://localhost:8787/mcp/${token}`,
    steps: [
      'Open ChatGPT Settings → Apps & Connectors.',
      'Enable Developer Mode, then choose Add connector.',
      'Paste the URL above and save.',
    ],
  },
  gemini: {
    url: 'http://localhost:8787/mcp',
    steps: [
      'Open Gemini Apps → Create a custom app.',
      'Choose OAuth and enter the local server URL.',
      'Paste the access key when prompted to authorize.',
    ],
  },
};
let skills = [
  {
    name: 'code-review',
    description: 'Review changes for correctness, security, and maintainability.',
    source: 'builtin',
    dir: '/app/skills/code-review',
    files: ['SKILL.md'],
    enabled: true,
    editable: false,
    body: '# Code review\n\nReview the diff for correctness, edge cases, and clear explanations.',
  },
  {
    name: 'skill-authoring',
    description: 'Create focused skills with clear triggers and instructions.',
    source: 'builtin',
    dir: '/app/skills/skill-authoring',
    files: ['SKILL.md', 'references/examples.md'],
    enabled: true,
    editable: false,
    body: '# Skill authoring\n\nWrite a concise, reusable skill.',
  },
  {
    name: 'my-release-checklist',
    description: 'A short checklist before preparing a release.',
    source: 'user',
    dir: '/data/skills/my-release-checklist',
    files: ['SKILL.md', 'checklist.md'],
    enabled: false,
    editable: true,
    body: '# Release checklist\n\n1. Review the changes.\n2. Run the relevant checks.',
  },
];
let commands = [
  {
    name: 'review',
    description: 'Review uncommitted changes and report bugs.',
    args: ['focus'],
    source: 'builtin',
    editable: false,
    template: 'Review the current changes. Focus on {{focus}}.',
  },
  {
    name: 'explain',
    description: 'Explain a code path or design decision.',
    args: ['topic'],
    source: 'builtin',
    editable: false,
    template: 'Explain {{topic}}.',
  },
  {
    name: 'release-notes',
    description: 'Draft release notes from recent changes.',
    args: ['version'],
    source: 'user',
    editable: true,
    template: 'Draft release notes for {{version}}.',
  },
];
const toolDefinitions = [
  ['workspace_info', 'Workspace info', 'Active root, stack, git status and guidance files.', 'Workspace', 'read', 'essential'],
  ['workspace_switch', 'Switch workspace', 'Choose the active project root.', 'Workspace', 'read', 'essential'],
  ['read', 'Read files', 'Read one or more workspace files.', 'Workspace', 'read', 'essential'],
  ['list', 'List files', 'Browse the workspace tree.', 'Workspace', 'read', 'essential'],
  ['search', 'Search', 'Search file names and contents.', 'Workspace', 'read', 'essential'],
  ['write', 'Write file', 'Create or overwrite a file.', 'File changes', 'write', 'essential'],
  ['edit', 'Edit file', 'Apply exact replacements.', 'File changes', 'write', 'essential'],
  ['apply_patch', 'Apply patch', 'Apply a multi-file patch.', 'File changes', 'write', 'essential'],
  ['file_ops', 'File operations', 'Move, copy, delete or create folders.', 'File changes', 'write', 'essential'],
  ['undo', 'Undo changes', 'Restore a checkpoint.', 'File changes', 'write', 'essential'],
  ['run', 'Run command', 'Run a shell command in the workspace.', 'Execution', 'exec', 'essential'],
  ['job', 'Manage jobs', 'Inspect a background command.', 'Execution', 'read', 'essential'],
  ['job_stop', 'Stop job', 'Stop a background process.', 'Execution', 'exec', 'essential'],
  ['git', 'Git status', 'Inspect git history and changes.', 'Git', 'read', 'essential'],
  ['git_write', 'Git write', 'Commit, switch branches, or manage changes.', 'Git', 'exec', 'essential'],
  ['skills_list', 'List skills', 'List enabled skills.', 'Knowledge', 'read', 'essential'],
  ['skill_load', 'Load skill', 'Read skill instructions and files.', 'Knowledge', 'read', 'essential'],
  ['skill_save', 'Save skill', 'Create or update a skill.', 'Knowledge', 'write', 'essential'],
  ['commands_list', 'List commands', 'List prompt commands.', 'Knowledge', 'read', 'essential'],
  ['command_run', 'Run command prompt', 'Expand a reusable command template.', 'Knowledge', 'read', 'essential'],
  ['fetch_url', 'Fetch URL', 'Read a web page as text.', 'Research', 'read', 'essential'],
  ['status', 'Server status', 'Inspect server configuration.', 'System', 'read', 'essential'],
];
let tools = toolDefinitions.map(([name, title, description, group, risk, profile]) => ({
  name, title, description, group, risk, profile, enabled: true,
}));
let settings = {
  disabledTools: [],
  disabledSkills: [],
  approvalMode: 'minimal',
  toolProfile: 'essential',
};
let activity = [
  {
    id: 6,
    ts: new Date(Date.now() - 9000).toISOString(),
    client: 'chatgpt',
    tool: 'browser_check',
    args: 'url: http://localhost:3000',
    ok: true,
    summary: '0 console errors',
    ms: 324,
  },
  {
    id: 5,
    ts: new Date(Date.now() - 12000).toISOString(),
    client: 'gemini',
    tool: 'run',
    args: 'command: npm run verify',
    ok: true,
    summary: '3/3 checks passed',
    ms: 2100,
  },
  {
    id: 4,
    ts: new Date(Date.now() - 15000).toISOString(),
    client: 'chatgpt',
    tool: 'edit_files',
    args: 'ops: 2 patches',
    ok: true,
    summary: 'Diagnostics: 2 errors',
    ms: 46,
  },
  {
    id: 3,
    ts: new Date(Date.now() - 18000).toISOString(),
    client: 'chatgpt',
    tool: 'read',
    args: 'paths: ["src/index.ts"]',
    ok: true,
    summary: 'Read 1 file',
    ms: 14,
  },
  {
    id: 2,
    ts: new Date(Date.now() - 62000).toISOString(),
    client: 'gemini',
    tool: 'search',
    args: 'query: "TODO", glob: "src/**"',
    ok: true,
    summary: 'Found 4 matches',
    ms: 38,
  },
  {
    id: 1,
    ts: new Date(Date.now() - 170000).toISOString(),
    client: 'chatgpt',
    tool: 'run',
    args: 'command: npm run typecheck',
    ok: false,
    summary: 'Command exited with code 2',
    ms: 1280,
  },
];
const listeners = new Set();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error(message);
}

export async function request(path, options = {}) {
  await new Promise((resolve) => setTimeout(resolve, 40));
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : {};

  if (path === '/status') return clone(status);
  if (path === '/health') {
    return { status: 'ok', uptimeSec: status.uptimeSec, mcpReachable: true };
  }
  if (path === '/connect') return clone(connect);
  if (path === '/token/rotate' && method === 'POST') {
    connect.token = `lc_demo_${Math.random().toString(36).slice(2, 12)}`;
    connect.chatgpt.url = `http://localhost:8787/mcp/${connect.token}`;
    return { token: connect.token };
  }
  if (path === '/tools' && method === 'GET') return clone(tools);

  const toolMatch = path.match(/^\/tools\/([^/]+)$/);
  if (toolMatch && method === 'PATCH') {
    const tool = tools.find((item) => item.name === decodeURIComponent(toolMatch[1]));
    if (!tool) fail('Tool not found');
    tool.enabled = Boolean(body.enabled);
    return clone(tool);
  }

  if (path === '/skills' && method === 'GET') return clone(skills);
  if (path === '/skills' && method === 'POST') {
    const skill = {
      name: body.name,
      description: body.description,
      source: 'user',
      dir: `/data/skills/${body.name}`,
      files: ['SKILL.md', ...Object.keys(body.files || {})],
      enabled: true,
      editable: true,
      body: body.body,
    };
    upsert(skills, skill);
    return clone(skill);
  }

  if (path === '/skills/import' && method === 'POST') {
    let name;
    let description;
    let bodyText;
    if (body.path) {
      name = body.path.split('/').filter(Boolean).pop() || 'imported-skill';
      description = 'Imported from server path';
      bodyText = `# ${name}\n\nImported skill instructions.`;
    } else {
      const markdown = body.markdown || '';
      const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
      name = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1].trim() || 'imported-skill';
      description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim() || 'Imported skill';
      bodyText = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    }
    const skill = {
      name,
      description,
      source: 'user',
      dir: `/data/skills/${name}`,
      files: ['SKILL.md', ...Object.keys(body.files || {})],
      enabled: true,
      editable: true,
      body: bodyText,
    };
    upsert(skills, skill);
    return clone(skill);
  }

  const skillMatch = path.match(/^\/skills\/([^/]+)$/);
  if (skillMatch) {
    const name = decodeURIComponent(skillMatch[1]);
    const skill = skills.find((item) => item.name === name);
    if (method === 'GET') return skill ? clone(skill) : fail('Skill not found');
    if (method === 'PATCH') {
      if (!skill) fail('Skill not found');
      skill.enabled = Boolean(body.enabled);
      return clone(skill);
    }
    if (method === 'DELETE') {
      skills = skills.filter((item) => item.name !== name);
      return null;
    }
  }

  if (path === '/commands' && method === 'GET') return clone(commands);
  if (path === '/commands' && method === 'POST') {
    const command = { ...body, args: body.args || [], source: 'user', editable: true };
    upsert(commands, command);
    return clone(command);
  }

  const commandMatch = path.match(/^\/commands\/([^/]+)$/);
  if (commandMatch) {
    const name = decodeURIComponent(commandMatch[1]);
    const command = commands.find((item) => item.name === name);
    if (method === 'GET') return command ? clone(command) : fail('Command not found');
    if (method === 'DELETE') {
      commands = commands.filter((item) => item.name !== name);
      return null;
    }
  }

  if (path === '/settings' && method === 'GET') return clone(settings);
  if (path === '/settings' && method === 'PATCH') {
    if (body.approvalMode && !['trust', 'minimal', 'standard'].includes(body.approvalMode)) {
      fail('Approval mode must be trust, minimal, or standard');
    }
    settings = { ...settings, ...body };
    status.approvalMode = settings.approvalMode;
    status.toolProfile = settings.toolProfile;
    return clone(settings);
  }
  if (path.startsWith('/activity?')) return clone(activity);
  fail(`Mock API route not implemented: ${method} ${path}`);
}

function upsert(items, value) {
  const index = items.findIndex((item) => item.name === value.name);
  if (index < 0) items.unshift(value);
  else Object.assign(items[index], value);
}

export function stream(onEntry) {
  listeners.add(onEntry);
  return { close: () => listeners.delete(onEntry) };
}
