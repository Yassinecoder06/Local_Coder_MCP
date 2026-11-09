import { request, streamActivity } from '../api.js';
import { escapeHtml, pageHeader, timeAgo } from '../ui.js';

let activity = [];
let eventSource;
let paused = false;

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
  view.querySelector('#pause-activity').onclick = togglePause;
  view.querySelector('#clear-activity').onclick = () => {
    activity = [];
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
  body.innerHTML = activity.map((entry) => {
    const client = clientInfo(entry.client);
    return `<tr>
    <td><span class="client-cell"><span class="client-mini">${escapeHtml(client.icon)}</span>
      ${escapeHtml(client.label)}</span></td>
    <td><code>${escapeHtml(entry.tool)}</code></td>
    <td class="args-cell" title="${escapeHtml(entry.args || '')}">${escapeHtml(entry.args || '—')}</td>
    <td class="activity-result-cell"><span class="result ${entry.ok ? 'result-ok' : 'result-error'}">
      ${entry.ok ? '● OK' : '● Error'}</span>${resultSummaryChip(entry)}</td>
    <td>${Number(entry.ms) || 0} ms</td><td title="${escapeHtml(entry.ts)}">${timeAgo(entry.ts)}</td>
  </tr>`;
  }).join('');
  view.querySelector('#activity-empty').hidden = activity.length > 0;
  view.querySelector('#activity-count').textContent = `${activity.length} recent events`;
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
