import { request, send } from '../api.js';
import { bindCopyButtons, copyText, duration, escapeHtml, pageHeader, toast } from '../ui.js';

const clientIcon = { chatgpt: '✳', gemini: '✦' };

function renderClientCard(client, title, description) {
  const url = client.url || '';
  return `<article class="connect-card">
    <div class="connect-card-head">
      <div class="client-icon ${title.toLowerCase()}">${clientIcon[title.toLowerCase()] || '◉'}</div>
      <div><h2>${title}</h2><p>${description}</p></div><span class="client-state">Ready</span>
    </div>
    <div class="url-row"><code>${escapeHtml(url || 'URL unavailable')}</code>
      <button class="button button-small" data-copy="${escapeHtml(url)}" data-copy-message="URL copied">Copy URL</button>
    </div>
    <ol class="steps">${(client.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
  </article>`;
}

function publicUrlCallout(status) {
  const publicUrl = status.endpoints?.public;
  if (publicUrl) {
    return `<div class="notice notice-info"><span>↗</span><div>
      <strong>Public endpoint configured</strong>
      <p>Clients connect through <code>${escapeHtml(publicUrl)}</code>.</p>
    </div></div>`;
  }

  return `<div class="notice notice-warn"><span>ⓘ</span><div>
    <strong>No public URL yet</strong>
    <p>ChatGPT and Gemini need a public HTTPS URL. Start the optional tunnel with
      <code>docker compose --profile tunnel up</code>, then set <code>PUBLIC_URL</code>.</p>
  </div></div>`;
}

export async function renderConnect(view, status) {
  const connect = await request('/connect');
  const accessKey = connect.token || '';
  view.innerHTML = `${pageHeader(
    'GET STARTED',
    'Connect your AI client',
    'Add Local Coder once, then give it access to your local workspace.',
  )}
  <div class="status-strip">
    <div class="status-indicator"><span class="dot"></span><strong>Server running</strong></div>
    <span class="status-separator"></span><span><strong>${Number(status.sessions) || 0}</strong> active sessions</span>
    <span class="status-meta">v${escapeHtml(status.version || '—')} · up ${duration(status.uptimeSec)}</span>
  </div>
  <div class="connect-grid">
    ${renderClientCard(connect.chatgpt || {}, 'ChatGPT', 'Connect from ChatGPT web in Developer Mode.')}
    ${renderClientCard(connect.gemini || {}, 'Gemini', 'Connect with a Gemini custom app using OAuth.')}
  </div>
  <article class="panel key-panel">
    <div><p class="eyebrow">SERVER ACCESS KEY</p><h2>Keep your key private</h2>
      <p class="muted">The key authorizes clients to use your local tools.</p></div>
    <div class="key-controls"><div class="key-field">
      <input id="access-key" type="password" value="${escapeHtml(accessKey)}" readonly aria-label="Access key">
      <button class="icon-button" id="key-visibility" aria-label="Show access key">◉</button>
    </div><button class="button" id="copy-key">Copy key</button>
    <button class="button button-danger-quiet" id="rotate-key">Rotate key</button></div>
  </article>
  ${publicUrlCallout(status)}`;

  bindCopyButtons(view);
  view.querySelector('#key-visibility').onclick = () => {
    const input = view.querySelector('#access-key');
    input.type = input.type === 'password' ? 'text' : 'password';
    view.querySelector('#key-visibility').setAttribute(
      'aria-label', input.type === 'text' ? 'Hide access key' : 'Show access key',
    );
  };
  view.querySelector('#copy-key').onclick = () => {
    copyText(view.querySelector('#access-key').value, 'Access key copied');
  };
  view.querySelector('#rotate-key').onclick = async () => {
    if (!confirm('Rotate the access key? Existing client connections and OAuth tokens will stop working.')) {
      return;
    }
    try {
      await send('/token/rotate', 'POST');
      toast('Access key rotated');
      await renderConnect(view, status);
    } catch (error) {
      toast(error.message, true);
    }
  };
}
