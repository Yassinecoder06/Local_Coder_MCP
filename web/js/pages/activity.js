import { request, streamActivity } from '../api.js';
import { escapeHtml, pageHeader, timeAgo } from '../ui.js';

let activity = [];
let eventSource;
let paused = false;
const expandedExecs = new Set();

const CLIENTS = {
  chatgpt: { label: 'ChatGPT', icon: 'C' },
  gemini: { label: 'Gemini', icon: 'G' },
  claude: { label: 'Claude', icon: 'C' },
  'claude-code': { label: 'Claude Code', icon: 'CC' },
  cursor: { label: 'Cursor', icon: 'Cu' },
  vscode: { label: 'VS Code', icon: 'VS' },
  windsurf: { label: 'Windsurf', icon: 'W' },
  codex: { label: 'Codex', icon: 'Co' },
  'gemini-cli': { label: 'Gemini CLI', icon: 'G' },
  'le-chat': { label: 'Le Chat', icon: 'L' },
};

function clientInfo(name = '') {
  const raw = String(name).trim();
  const id = raw.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return CLIENTS[id] || { label: raw || 'Other', icon: '·' };
}

export async function renderActivity(view) {
  expandedExecs.clear();
  activity = await request('/activity?limit=100');
  view.innerHTML = `${pageHeader(
    'LIVE MONITOR',
    'Activity',
    'See the tool calls your AI clients make to this server.',
    '<span class="live-label"><span class="dot"></span> Live</span>',
  )}
  <div class="toolbar activity-toolbar"><span class="count-label" id="activity-count"></span>
    <div class="toolbar-actions"><button class="button button-small" id="pause-activity">Ⅱ Pause</button>
      <button class="button button-small" id="clear-activity">Clear view</button></div>
  </div><div class="activity-table-wrap"><table class="activity-table">
    <thead><tr><th>Client</th><th>Tool</th><th>Arguments</th><th>Result</th><th>Duration</th><th>Time</th></tr></thead>
    <tbody id="activity-body"></tbody></table></div>
  <div id="activity-empty" class="empty-state compact" hidden><div class="empty-icon">↗</div>
    <h2>No activity yet</h2><p>Tool calls will appear here as they happen.</p></div>`;
  drawActivity(view);
  view.querySelector('#activity-body').onclick = (event) => {
    const toggle = event.target.closest('[data-exec-toggle]');
    if (!toggle) return;
    const id = toggle.dataset.execToggle;
    if (expandedExecs.has(id)) expandedExecs.delete(id);
    else expandedExecs.add(id);
    drawActivity(view);
  };
  view.querySelector('#pause-activity').onclick = togglePause;
  view.querySelector('#clear-activity').onclick = () => {
    activity = [];
    expandedExecs.clear();
    drawActivity(view);
  };
  eventSource?.close();
  eventSource = streamActivity((entry) => {
    if (location.hash.slice(1) !== 'activity' || paused) return;
    activity.unshift(entry);
    activity = activity.slice(0, 100);
    drawActivity(view);
  });
}

export function closeActivityStream() {
  eventSource?.close();
  eventSource = undefined;
}

function togglePause(event) {
  paused = !paused;
  event.currentTarget.textContent = paused ? '▶ Resume' : 'Ⅱ Pause';
  event.currentTarget.classList.toggle('selected', paused);
}

function drawActivity(view) {
  const body = view.querySelector('#activity-body');
  if (!body) return;
  body.innerHTML = groupActivity(activity).map(({ entry, children }) => {
    const id = String(entry.id);
    const expanded = expandedExecs.has(id);
    const childRows = children
      .map((child, index) => renderActivityRow(child, id, index, !expanded))
      .join('');
    const childIds = children.map((_, index) => `exec-inner-${id}-${index}`).join(' ');
    const toggleRow = children.length ? `<tr class="activity-group-toggle">
      <td colspan="6"><button type="button" data-exec-toggle="${escapeHtml(id)}"
        aria-expanded="${expanded}" aria-controls="${escapeHtml(childIds)}">
        ${children.length} inner calls</button></td>
    </tr>` : '';
    const rows = `${renderActivityRow(entry)}${toggleRow}`;
    return `${rows}${childRows}`;
  }).join('');
  view.querySelector('#activity-empty').hidden = activity.length > 0;
  view.querySelector('#activity-count').textContent = `${activity.length} recent events`;
}

function groupActivity(entries) {
  const rows = [];
  const parentBySession = new Map();
  for (const entry of entries) {
    const parent = entry.via === 'exec' && entry.session
      ? parentBySession.get(entry.session)
      : null;
    if (parent) {
      parent.children.push(entry);
      continue;
    }

    const row = { entry, children: [] };
    rows.push(row);
    if (entry.tool === 'exec' && entry.session) parentBySession.set(entry.session, row);
  }
  return rows;
}

function renderActivityRow(entry, parentId = '', childIndex = 0, hidden = false) {
  const nested = Boolean(parentId);
  const client = clientInfo(entry.client);
  const args = entry.tool === 'run' ? commandArgs(entry.args) : entry.args || '—';
  const rowId = nested
    ? ` id="exec-inner-${escapeHtml(parentId)}-${childIndex}"`
    : '';
  return `<tr class="${nested ? 'activity-child-row' : ''}"${rowId}${hidden ? ' hidden' : ''}>
    <td><span class="client-cell"><span class="client-mini">${escapeHtml(client.icon)}</span>
      ${escapeHtml(client.label)}</span></td>
    <td><code>${escapeHtml(entry.tool)}</code></td>
    <td class="args-cell" title="${escapeHtml(entry.args || '')}">${escapeHtml(args)}</td>
    <td class="activity-result-cell"><span class="result ${entry.ok ? 'result-ok' : 'result-error'}">
      ${entry.ok ? '● OK' : '● Error'}</span>${resultSummaryChip(entry)}</td>
    <td>${Number(entry.ms) || 0} ms</td><td title="${escapeHtml(entry.ts)}">${timeAgo(entry.ts)}</td>
  </tr>`;
}

function commandArgs(args = '') {
  const raw = String(args);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      try {
        parsed = JSON.parse(raw.slice(jsonStart));
      } catch {
        // Fall through to a small fallback for clipped activity summaries.
      }
    }
  }
  if (Array.isArray(parsed?.cmds)) return `${parsed.cmds.length} commands`;

  const match = raw.match(/["']?cmds["']?\s*:\s*\[([\s\S]*)/i);
  if (!match) return raw || '—';
  const count = match[1].match(/"(?:\\.|[^"\\])*"/g)?.length || 0;
  return count ? `${count}+ commands` : 'commands';
}

function resultSummaryChip(entry) {
  const summary = String(entry.summary || '').trim();
  if (!summary) return '';

  const tool = String(entry.tool || '').toLowerCase();
  const isEditDiagnostics = tool === 'edit_files'
    && /diagnostic|\b\d+\s+errors?\b|\b\d+\s+warnings?\b/i.test(summary);
  const isVerifiedRun = tool === 'run'
    && /\bverify\b/i.test(`${entry.args || ''} ${summary}`);
  if (!isEditDiagnostics && !isVerifiedRun && tool !== 'browser_check') return '';

  const label = summary
    .replace(/^(?:edit_files|run|browser_check)\s*:\s*/i, '')
    .replace(/^diagnostics?\s*:\s*/i, '')
    .replace(/^verify\s*:\s*/i, '')
    .trim();
  if (!label) return '';

  return `<span class="activity-summary-chip" title="${escapeHtml(summary)}">
    ${escapeHtml(label)}</span>`;
}
