import { request, send } from '../api.js';
import {
  confirmAction,
  copyText,
  duration,
  escapeHtml,
  integrationsCard,
  pageHeader,
  toast,
} from '../ui.js';

const MASK = '••••••••';
const clients = [
  { id: 'chatgpt', label: 'ChatGPT', icon: 'C' },
  { id: 'gemini', label: 'Gemini', icon: 'G' },
  { id: 'claude', label: 'Claude', icon: 'C' },
  { id: 'claude-code', label: 'Claude Code', icon: 'CC', configFile: 'Terminal command' },
  { id: 'cursor', label: 'Cursor', icon: 'Cu', configFile: '~/.cursor/mcp.json' },
  { id: 'vscode', label: 'VS Code', icon: 'VS', configFile: '.vscode/mcp.json' },
  { id: 'gemini-cli', label: 'Gemini CLI', icon: 'G', configFile: '~/.gemini/settings.json' },
  { id: 'codex', label: 'Codex CLI', icon: 'Co', configFile: '~/.codex/config.toml' },
  { id: 'other', label: 'Other', icon: '…' },
];

function selectedClient() {
  try {
    const saved = localStorage.getItem('lc-connect-client');
    return clients.some((client) => client.id === saved) ? saved : clients[0].id;
  } catch {
    return clients[0].id;
  }
}

function saveSelectedClient(id) {
  try {
    localStorage.setItem('lc-connect-client', id);
  } catch {
    // The picker remains usable when local storage is unavailable.
  }
}

function normalizeClients(connect) {
  let normalized;
  if (Array.isArray(connect.clients)) {
    normalized = Object.fromEntries(connect.clients.map((client) => [
      normalizeClientId(client?.id || client?.name),
      client,
    ]).filter(([id]) => id));
  } else if (connect.clients && typeof connect.clients === 'object') {
    normalized = Object.fromEntries(Object.entries(connect.clients).map(([id, client]) => [
      normalizeClientId(client?.id || id),
      client,
    ]));
  } else {
    // Older API responses expose setup URLs under these two client keys.
    return {
      chatgpt: { url: connect.chatgpt?.url },
      gemini: { url: connect.gemini?.url },
    };
  }

  // Preserve old endpoint fields when a newer clients list omits a URL.
  for (const id of ['chatgpt', 'gemini']) {
    normalized[id] = { ...(normalized[id] || {}) };
    if (!normalized[id].url && connect[id]?.url) normalized[id].url = connect[id].url;
  }
  return normalized;
}

function normalizeClientId(id) {
  return String(id || '').trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
}

function getMcpUrl(connect, status, clientData) {
  const legacyUrl = clientData.gemini?.url || connect.gemini?.url;
  const serverBase = status.endpoints?.public || status.endpoints?.local;
  return connect.mcpUrl || connect.url
    || (serverBase ? `${serverBase.replace(/\/+$/, '')}/mcp` : legacyUrl || '');
}

function getAccessKey(connect, status, clientData) {
  if (connect.token || connect.accessKey) return connect.token || connect.accessKey;
  const clientUrls = Object.values(clientData).map((client) => client?.url || '');
  const tokenUrl = [
    connect.chatgpt?.url,
    status.endpoints?.mcpUrlWithToken,
    ...clientUrls,
  ].find((candidate) => /\/mcp\/[^/?#]+/.test(candidate || '')) || '';
  return tokenUrl.match(/\/mcp\/([^/?#]+)/)?.[1] || '';
}

function defaultSteps(id, url) {
  const safeUrl = url || '<base>/mcp';
  const steps = {
    chatgpt: [
      'Open Settings → Apps & Connectors → Advanced → Developer mode → Create.',
      `Set the MCP URL to ${safeUrl} and choose OAuth; sign in with the access key.`,
      'For legacy No auth setup, use the existing /mcp/<key> URL.',
    ],
    gemini: [
      'Open Settings → Connected apps → Add custom app.',
      `Enter ${safeUrl}; leave Client ID and Client secret empty.`,
      'Continue and sign in with the access key.',
    ],
    claude: [
      'Open Settings → Connectors → Add custom connector.',
      `Enter ${safeUrl}, add the connector, then sign in with the access key.`,
      'The same remote connector can be used from Claude.ai and Claude Desktop.',
    ],
    'claude-code': [
      'Run the command below in a terminal where Claude Code is installed.',
      'The command registers this remote server for Claude Code.',
    ],
    cursor: ['Add the server entry to ~/.cursor/mcp.json, then reload Cursor.'],
    vscode: ['Add the server entry to .vscode/mcp.json, then reload the MCP server.'],
    'gemini-cli': ['Add the server entry to ~/.gemini/settings.json, then restart Gemini CLI.'],
    codex: [
      'Add the server entry to ~/.codex/config.toml.',
      'Export LOCAL_CODER_TOKEN in the environment used to launch Codex CLI.',
    ],
    other: [
      `Set the remote Streamable HTTP MCP URL to ${safeUrl}.`,
      'Send Authorization: Bearer <access key>, or use OAuth discovery when supported.',
    ],
  };
  return steps[id] || steps.other;
}

function defaultSnippet(id, url, token) {
  const authorization = `Bearer ${token || '<access key>'}`;
  if (id === 'claude-code') {
    return `claude mcp add --transport http local-coder ${shellQuote(url)} \\\n  --header ${shellQuote(`Authorization: ${authorization}`)}`;
  }
  if (id === 'cursor') {
    return JSON.stringify({ mcpServers: { 'local-coder': {
      url,
      headers: { Authorization: authorization },
    } } }, null, 2);
  }
  if (id === 'vscode') {
    return JSON.stringify({ servers: { 'local-coder': {
      type: 'http',
      url,
      headers: { Authorization: authorization },
    } } }, null, 2);
  }
  if (id === 'gemini-cli') {
    return JSON.stringify({ mcpServers: { 'local-coder': {
      httpUrl: url,
      headers: { Authorization: authorization },
    } } }, null, 2);
  }
  if (id === 'codex') {
    return `[mcp_servers.local-coder]\nurl = "${url}"\nbearer_token_env_var = "LOCAL_CODER_TOKEN"`;
  }
  return '';
}

function codexEnvironment(token) {
  return `export LOCAL_CODER_TOKEN=${shellQuote(token || '<access key>')}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function configDetails(client, remote, url, token) {
  if (!client.configFile) return null;
  const configValue = remote.snippet || remote.configSnippet || remote.config
    || remote.configuration
    || defaultSnippet(client.id, url, token);
  const snippet = resolveTemplate(
    typeof configValue === 'string' ? configValue : JSON.stringify(configValue, null, 2),
    url,
    token,
  );
  if (!snippet) return null;
  return {
    path: remote.configFile || remote.configPath || remote.path || client.configFile,
    snippet: String(snippet),
  };
}

function resolveTemplate(value, url, token) {
  return String(value || '')
    .replaceAll('{{url}}', url || '<base>/mcp')
    .replaceAll('<base>', url ? url.replace(/\/mcp\/?$/, '') : '<base>')
    .replaceAll('{{token}}', token || '<access key>');
}

function renderClientDetails(client, remote, url, token) {
  const defaults = defaultSteps(client.id, url);
  const remoteSteps = [remote.steps, remote.setupSteps, remote.instructions]
    .find(Array.isArray);
  const steps = remoteSteps || defaults;
  const config = configDetails(client, remote, url, token);
  const legacyUrl = client.id === 'chatgpt' && /\/mcp\/[^/?#]+/.test(remote.url || '')
    ? remote.url
    : '';
  const maskedLegacyUrl = token ? legacyUrl.replaceAll(token, MASK) : legacyUrl;
  const renderedSteps = steps.map((step) => {
    let text = typeof step === 'string' ? step : step.text || step.label || '';
    text = String(text)
      .replaceAll('<base>', url || '<base>')
      .replaceAll('{{url}}', url || '<base>/mcp')
      .replaceAll('{{token}}', token ? MASK : '<access key>');
    if (token) text = text.replaceAll(token, MASK);
    return `<li>${escapeHtml(text)}</li>`;
  }).join('');
  const snippet = config?.snippet || '';
  const visibleSnippet = token ? snippet.replaceAll(token, MASK) : snippet;
  const environment = client.id === 'codex' ? codexEnvironment(token) : '';
  const visibleEnvironment = token ? environment.replaceAll(token, MASK) : environment;

  return `<div class="client-instructions">
    <ol class="steps">${renderedSteps}</ol>
    ${legacyUrl ? `<div class="legacy-url-row"><div><strong>Legacy No auth URL</strong>
      <code>${escapeHtml(maskedLegacyUrl)}</code></div>
      <button class="button button-small" type="button" data-copy-legacy-url>
        Copy URL</button></div>` : ''}
    ${config ? `<section class="config-block" aria-label="Client configuration">
      <div class="config-block-head"><div><strong>Configuration</strong>
        <code>${escapeHtml(config.path)}</code></div>
        <button class="button button-small" type="button" data-copy-config="${client.id}">
          Copy config</button></div>
      <pre><code>${escapeHtml(visibleSnippet)}</code></pre>
    </section>` : ''}
    ${environment ? `<section class="config-block" aria-label="Codex token environment">
      <div class="config-block-head"><div><strong>Shell environment</strong>
        <code>Set before launching Codex CLI</code></div>
        <button class="button button-small" type="button" data-copy-environment>
          Copy command</button></div>
      <pre><code>${escapeHtml(visibleEnvironment)}</code></pre>
    </section>` : ''}
  </div>`;
}

function renderPicker(view, clientData, url, token) {
  const picker = view.querySelector('#client-picker');
  picker.innerHTML = clients.map((client) => `<button type="button" role="tab"
    id="client-tab-${client.id}" aria-controls="client-details"
    aria-selected="${client.id === selectedClient()}" data-client="${client.id}"
    class="client-tab${client.id === selectedClient() ? ' selected' : ''}">
    <span class="client-tab-icon" aria-hidden="true">${client.icon}</span>
    <span>${client.label}</span></button>`).join('');

  const details = view.querySelector('#client-details');
  function selectClient(id) {
    const client = clients.find((entry) => entry.id === id) || clients[0];
    saveSelectedClient(client.id);
    picker.querySelectorAll('[data-client]').forEach((button) => {
      const selected = button.dataset.client === client.id;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const candidate = clientData[client.id];
    const remote = candidate && typeof candidate === 'object' ? candidate : {};
    details.setAttribute('aria-labelledby', `client-tab-${client.id}`);
    details.innerHTML = `<div class="client-detail-heading"><h2>${client.label}</h2>
      <span class="muted">${escapeHtml(remote.description || 'Connect with MCP over Streamable HTTP.')}</span>
    </div>${renderClientDetails(client, remote, url, token)}`;
    const copyConfig = details.querySelector('[data-copy-config]');
    if (copyConfig) copyConfig.onclick = () => {
      const snippet = configDetails(client, remote, url, token)?.snippet || '';
      copyText(snippet, 'Configuration copied');
    };
    const copyEnvironment = details.querySelector('[data-copy-environment]');
    if (copyEnvironment) copyEnvironment.onclick = () => {
      copyText(codexEnvironment(token), 'Environment command copied');
    };
    const copyLegacyUrl = details.querySelector('[data-copy-legacy-url]');
    if (copyLegacyUrl) copyLegacyUrl.onclick = () => {
      copyText(remote.url, 'Legacy URL copied');
    };
  }

  picker.querySelectorAll('[data-client]').forEach((button) => {
    button.tabIndex = button.dataset.client === selectedClient() ? 0 : -1;
    button.onclick = () => selectClient(button.dataset.client);
    button.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...picker.querySelectorAll('[data-client]')];
      const current = tabs.indexOf(button);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    };
  });
  selectClient(selectedClient());
}

function publicUrlCallout(status) {
  const publicUrl = status.endpoints?.public;
  if (publicUrl) {
    return `<div class="notice notice-info"><span>↗</span><div>
      <strong>Public endpoint configured</strong>
      <p>Remote clients connect through <code>${escapeHtml(publicUrl)}</code>.</p>
    </div></div>`;
  }

  return `<div class="notice notice-warn"><span>ⓘ</span><div>
    <strong>No public URL yet</strong>
    <p>Remote MCP clients need a public HTTPS URL. Start the optional tunnel with
      <code>docker compose --profile tunnel up</code>, then set <code>PUBLIC_URL</code>.</p>
  </div></div>`;
}

export async function renderConnect(view, status) {
  const connect = await request('/connect');
  const clientData = normalizeClients(connect);
  const url = getMcpUrl(connect, status, clientData);
  const token = getAccessKey(connect, status, clientData);
  view.innerHTML = `${pageHeader(
    'GET STARTED',
    'Connect your AI client',
    'Connect any MCP-compatible app, editor, or agent to your local workspace.',
  )}
  <div class="status-strip">
    <div class="status-indicator"><span class="dot"></span><strong>Server running</strong></div>
    <span class="status-separator"></span><span><strong>${Number(status.sessions) || 0}</strong> active sessions</span>
    <span class="status-meta">v${escapeHtml(status.version || '—')} · up ${duration(status.uptimeSec)}</span>
  </div>
  <article class="panel universal-connect-card">
    <div class="universal-card-heading"><p class="eyebrow">UNIVERSAL MCP CONNECTION</p>
      <h2>Connect your client</h2>
      <p class="muted">Use the same MCP endpoint with any compatible client.</p></div>
    <div class="universal-connection-fields">
      <div class="connection-field"><span>MCP URL</span><div class="url-row">
        <code>${escapeHtml(url || 'MCP URL unavailable')}</code>
        <button class="button button-small" type="button" id="copy-mcp-url">Copy URL</button>
      </div></div>
      <div class="connection-field"><span>Access key</span><div class="key-field">
        <input id="access-key" type="password" value="${escapeHtml(token)}" readonly
          aria-label="Access key">
        <button class="icon-button" id="key-visibility" type="button"
          aria-label="Show access key">◉</button>
        <button class="button button-small" id="copy-key" type="button">Copy key</button>
        <button class="button button-small button-danger-quiet" id="rotate-key" type="button">
          Rotate</button>
      </div></div>
    </div>
    <div class="auth-methods"><span>Authentication</span>
      <span class="auth-method">OAuth sign-in</span><span class="auth-method">Bearer header</span>
    </div>
    <p class="legacy-auth-note">Existing path-token URLs at <code>/mcp/&lt;key&gt;</code> remain supported.</p>
  </article>
  <p class="connect-approval-hint">Seeing Allow prompts? Click Always allow once per tool, or enable
    <a href="#settings">Trust mode in Settings</a>.</p>
  <p class="plugins-connect-hint">Need more tools? <a href="#plugins">Add plugins in Admin → Plugins</a> — they work in this same connector.</p>
  <section class="client-picker-section" aria-label="Client setup instructions">
    <div class="client-picker-heading"><h2>Choose your client</h2>
      <span class="muted">Setup instructions and configuration</span></div>
    <div class="client-picker" id="client-picker" role="tablist" aria-label="MCP clients"></div>
    <div class="panel client-details" id="client-details" role="tabpanel"></div>
  </section>
  ${publicUrlCallout(status)}
  ${integrationsCard(status.integrations)}`;

  renderPicker(view, clientData, url, token);
  view.querySelector('#copy-mcp-url').onclick = () => copyText(url, 'MCP URL copied');
  view.querySelector('#key-visibility').onclick = () => {
    const input = view.querySelector('#access-key');
    input.type = input.type === 'password' ? 'text' : 'password';
    view.querySelector('#key-visibility').setAttribute(
      'aria-label', input.type === 'text' ? 'Hide access key' : 'Show access key',
    );
  };
  view.querySelector('#copy-key').onclick = () => copyText(token, 'Access key copied');
  view.querySelector('#rotate-key').onclick = async () => {
    const confirmed = await confirmAction(
      'Rotate the access key? Existing client connections and OAuth tokens will stop working.',
      { title: 'Rotate access key?', confirmLabel: 'Rotate key' },
    );
    if (!confirmed) return;
    try {
      await send('/token/rotate', 'POST');
      toast('Access key rotated');
      await renderConnect(view, status);
    } catch (error) {
      toast(error.message, true);
    }
  };
}
