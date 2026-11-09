import { request, send } from '../api.js';
import { escapeHtml, pageHeader, timeAgo, toast, copyText } from '../ui.js';

let requests = [];
let finishes = [];
let plan = { workspace: '', todos: [], updatedAt: '' };
let currentView;

export async function refreshOpenRequestCount() {
  const badge = document.querySelector('#open-request-count');
  if (!badge) return;
  try {
    const open = await request('/requests?status=open');
    setOpenRequestBadge(open.length);
  } catch {
    badge.hidden = true;
  }
}

export async function renderRequests(view) {
  currentView = view;
  [requests, finishes, plan] = await Promise.all([
    request('/requests'),
    request('/finishes?limit=20'),
    request('/plan'),
  ]);
  view.innerHTML = `${pageHeader('HUMAN IN THE LOOP', 'Requests', 'Review requested steps, follow the live plan, and see how each task was verified.')}
    <section class="board-section" aria-labelledby="requests-heading">
      <div class="section-heading"><div><p class="eyebrow">NEEDS YOUR ATTENTION</p><h2 id="requests-heading">Open requests</h2></div>
        <span class="board-count" id="requests-open-count"></span></div>
      <div class="request-list" id="request-list"></div>
      <details class="closed-requests" id="closed-requests"><summary>Closed requests <span id="closed-request-count"></span></summary>
        <div class="request-list" id="closed-request-list"></div></details>
    </section>
    <section class="board-section" aria-labelledby="plan-heading">
      <div class="section-heading"><div><p class="eyebrow">CURRENT WORK</p><h2 id="plan-heading">Plan</h2></div><span class="plan-workspace" id="plan-workspace"></span></div>
      <div class="panel plan-panel" id="plan-panel"></div>
    </section>
    <section class="board-section" aria-labelledby="finishes-heading">
      <div class="section-heading"><div><p class="eyebrow">PROVEN FINISH</p><h2 id="finishes-heading">Recent finishes</h2></div></div>
      <div class="finish-list" id="finish-list"></div>
    </section>`;
  draw();

  view.querySelector('#request-list').addEventListener('click', handleRequestAction);
  view.querySelector('#closed-request-list').addEventListener('click', handleRequestAction);
  view.querySelector('#request-list').addEventListener('click', handleCopy);

  document.removeEventListener('board:event', onBoardEvent);
  document.addEventListener('board:event', onBoardEvent);
}

export function closeBoardStream() {
  document.removeEventListener('board:event', onBoardEvent);
  currentView = undefined;
}

function onBoardEvent(event) {
  handleBoardEvent(event.detail);
}

function handleBoardEvent(event) {
  if (!currentView || location.hash.slice(1) !== 'requests') return;
  if (event.type === 'request') {
    const index = requests.findIndex((item) => item.id === event.request.id);
    if (index < 0) requests.unshift(event.request);
    else requests[index] = event.request;
    draw();
  } else if (event.type === 'finish') {
    finishes = [event.finish, ...finishes.filter((item) => item.id !== event.finish.id)].slice(0, 20);
    drawFinishes();
  } else if (event.type === 'plan' && (!plan.workspace || event.workspace === plan.workspace)) {
    plan = { ...plan, workspace: event.workspace, todos: event.todos, updatedAt: new Date().toISOString() };
    drawPlan();
  }
}

function draw() {
  const open = requests.filter((item) => item.status === 'open');
  const closed = requests.filter((item) => item.status !== 'open').slice().reverse();
  setOpenRequestBadge(open.length);
  currentView.querySelector('#requests-open-count').textContent = `${open.length} open`;
  currentView.querySelector('#closed-request-count').textContent = `(${closed.length})`;
  currentView.querySelector('#request-list').innerHTML = open.length
    ? open.map(renderRequest).join('')
    : '<div class="panel board-empty"><span class="empty-icon">✓</span><div><strong>Nothing waiting for you</strong><p>New requests will appear here as they arrive.</p></div></div>';
  currentView.querySelector('#closed-request-list').innerHTML = closed.length
    ? closed.map(renderRequest).join('')
    : '<p class="muted closed-empty">No closed requests yet.</p>';
  drawPlan();
  drawFinishes();
}

function setOpenRequestBadge(count) {
  const badge = document.querySelector('#open-request-count');
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function renderRequest(item) {
  const open = item.status === 'open';
  const files = Array.isArray(item.expectedFiles) ? item.expectedFiles : [];
  return `<article class="panel request-card">
    <div class="request-card-heading"><div><p class="request-purpose">${escapeHtml(item.purpose || 'Action needed')}</p>
      <span class="request-meta">${escapeHtml(item.workspace || '')} · requested ${timeAgo(item.createdAt)}</span></div>
      <span class="board-status ${open ? 'status-open' : item.status === 'done' ? 'status-done' : 'status-skipped'}">${escapeHtml(item.status)}</span></div>
    <div class="request-command-heading"><strong>Run this command</strong>
      <button class="button button-small" type="button" data-copy="${escapeHtml(item.command || '')}">Copy</button></div>
    <pre class="request-command"><code>${escapeHtml(item.command || '')}</code></pre>
    <dl class="request-details"><div><dt>Folder</dt><dd><code>${escapeHtml(item.cwd || '')}</code></dd></div>
      <div><dt>Expected files</dt><dd>${files.length ? files.map((file) => `<code>${escapeHtml(file)}</code>`).join('') : '<span class="muted">None specified</span>'}</dd></div>
      ${item.constraints ? `<div><dt>Constraints</dt><dd>${escapeHtml(item.constraints)}</dd></div>` : ''}
      ${item.note ? `<div><dt>Note</dt><dd>${escapeHtml(item.note)}</dd></div>` : ''}</dl>
    ${open ? `<form class="request-close-form" data-request-id="${escapeHtml(item.id)}">
      <label class="sr-only" for="note-${escapeHtml(item.id)}">Optional note</label>
      <input id="note-${escapeHtml(item.id)}" name="note" maxlength="2000" placeholder="Optional note">
      <button class="button button-primary" type="submit" data-status="done">Mark done</button>
      <button class="button" type="submit" data-status="skipped">Skip</button></form>` : ''}
  </article>`;
}

async function handleRequestAction(event) {
  const form = event.target.closest('.request-close-form');
  if (!form || event.type !== 'click') return;
  const button = event.target.closest('button[data-status]');
  if (!button) return;
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  try {
    const updated = await send(`/requests/${encodeURIComponent(form.dataset.requestId)}`, 'POST', {
      status: button.dataset.status,
      note: form.elements.note.value,
    });
    const index = requests.findIndex((item) => item.id === updated.id);
    if (index >= 0) requests[index] = updated;
    draw();
    toast(updated.status === 'done' ? 'Request marked done' : 'Request skipped');
  } catch (error) {
    toast(error.message || 'Could not update request', true);
    button.disabled = false;
  }
}

function handleCopy(event) {
  const button = event.target.closest('[data-copy]');
  if (button) copyText(button.dataset.copy, 'Command copied');
}

function drawPlan() {
  if (!currentView) return;
  currentView.querySelector('#plan-workspace').textContent = plan.workspace || '';
  const todos = Array.isArray(plan.todos) ? plan.todos : [];
  currentView.querySelector('#plan-panel').innerHTML = todos.length
    ? `<ol class="todo-list">${todos.map(renderTodo).join('')}</ol><p class="plan-updated">Updated ${timeAgo(plan.updatedAt)}</p>`
    : '<div class="board-empty"><strong>No plan yet</strong><p>Tasks will show here when a plan is created.</p></div>';
}

function renderTodo(todo, index) {
  const item = typeof todo === 'string' ? { text: todo } : todo || {};
  const status = normalizeTodoStatus(item.status || item.state);
  const label = status === 'in-progress' ? 'In progress' : status[0].toUpperCase() + status.slice(1);
  return `<li class="todo-item todo-${status}"><span class="todo-marker" aria-hidden="true">${status === 'done' ? '✓' : status === 'in-progress' ? '◌' : index + 1}</span>
    <span class="todo-text">${escapeHtml(item.text || item.title || item.description || String(todo))}</span><span class="todo-state">${label}</span></li>`;
}

function normalizeTodoStatus(status = '') {
  const value = String(status).toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  if (['done', 'completed', 'complete'].includes(value)) return 'done';
  if (['in-progress', 'progress', 'active', 'doing'].includes(value)) return 'in-progress';
  return 'pending';
}

function drawFinishes() {
  if (!currentView) return;
  currentView.querySelector('#finish-list').innerHTML = finishes.length
    ? finishes.map(renderFinish).join('')
    : '<div class="panel board-empty"><strong>No finish reports yet</strong><p>Reports will appear here when a task is finished.</p></div>';
}

function renderFinish(item) {
  const evidence = item.evidence || {};
  const git = evidence.git;
  return `<article class="panel finish-card">
    <div class="finish-heading"><div><p class="eyebrow">${escapeHtml(item.workspace || '')} · ${timeAgo(item.createdAt)}</p><h3>${escapeHtml(item.summary || 'Task finished')}</h3></div>
      <span class="verified-badge ${item.verified ? 'verified' : 'unverified'}">${item.verified ? 'Verified' : 'Not verified'}</span></div>
    <div class="finish-files"><strong>Changed files</strong>${item.changedFiles?.length
      ? `<ul>${item.changedFiles.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul>`
      : '<p class="muted">No changed files reported.</p>'}</div>
    <div class="evidence-grid">
      ${renderEvidence('Verify', evidence.verify)}${renderEvidence('Browser check', evidence.browserCheck)}
      <div class="evidence-row"><strong>Git stats</strong><span>${git ? `${git.files} files · +${git.insertions} / −${git.deletions}${git.branch ? ` · ${escapeHtml(git.branch)}` : ''}` : 'Unavailable'}</span></div>
      <div class="evidence-row"><strong>Open requests</strong><span>${Number(evidence.openRequests) || 0}</span></div>
    </div>
    ${item.warnings?.length ? `<ul class="finish-warnings">${item.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
  </article>`;
}

function renderEvidence(label, evidence) {
  if (!evidence) return `<div class="evidence-row"><strong>${label}</strong><span>Not recorded</span></div>`;
  return `<div class="evidence-row"><strong>${label}</strong><span><b class="evidence-result ${evidence.ok ? 'evidence-ok' : 'evidence-fail'}">${evidence.ok ? 'Passed' : 'Failed'}</b>${escapeHtml(evidence.summary || '')}${evidence.at ? ` · ${timeAgo(evidence.at)}` : ''}</span></div>`;
}
