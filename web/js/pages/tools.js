import { request, send } from '../api.js';
import { escapeHtml, pageHeader, toast } from '../ui.js';

let tools = [];
let profile = 'essential';

export async function renderTools(view, status) {
  [tools, profile] = await Promise.all([
    request('/tools'),
    request('/settings').then((settings) => settings.toolProfile || status.toolProfile || 'essential'),
  ]);
  view.innerHTML = `${pageHeader(
    'MCP CONFIGURATION',
    'Tools',
    'Choose which capabilities your connected clients can use.',
  )}
  <div class="toolbar"><div class="segmented" role="group" aria-label="Tool profile">
    <button data-profile="essential">Essential <span>${tools.filter((tool) => tool.profile === 'essential').length}</span></button>
    <button data-profile="full">Full <span>${tools.length}</span></button>
  </div><span class="muted">Essential keeps the core workspace tools available.</span></div>
  <div id="tool-groups" class="tool-groups"></div>`;
  view.querySelectorAll('[data-profile]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.profile === profile);
    button.onclick = () => setProfile(button.dataset.profile, view);
  });
  drawTools(view);
}

async function setProfile(nextProfile, view) {
  try {
    await send('/settings', 'PATCH', { toolProfile: nextProfile });
    profile = nextProfile;
    view.querySelectorAll('[data-profile]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.profile === profile);
    });
    drawTools(view);
    toast(`Using ${profile} profile`);
  } catch (error) {
    toast(error.message, true);
  }
}

function drawTools(view) {
  const visibleTools = profile === 'full'
    ? tools
    : tools.filter((tool) => tool.profile === 'essential');
  const groups = new Map();
  for (const tool of visibleTools) {
    const group = tool.group || 'Other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(tool);
  }

  view.querySelector('#tool-groups').innerHTML = [...groups].map(([group, entries]) => `
    <section class="tool-group"><div class="section-heading"><h2>${escapeHtml(group)}</h2>
      <span>${entries.length} tools</span></div><div class="item-list">
      ${entries.map((tool) => `<article class="list-card tool-row">
        <span class="item-icon tool-icon">⊞</span><span class="item-copy">
          <strong>${escapeHtml(tool.title || tool.name)}</strong>
          <span>${escapeHtml(tool.description || tool.name)}</span>
          ${tool.name === 'exec' ? '<span class="tool-explainer">One call runs a JS program that calls other tools — saves tool calls in web chats.</span>' : ''}
        </span><span class="badge risk-${escapeHtml(tool.risk)}">${escapeHtml(tool.risk)}</span>
        <label class="switch"><input type="checkbox" data-tool-toggle="${escapeHtml(tool.name)}"
          ${tool.enabled ? 'checked' : ''}><span></span>
          <em class="sr-only">Enable ${escapeHtml(tool.name)}</em></label>
      </article>`).join('')}
    </div></section>`).join('');

  view.querySelectorAll('[data-tool-toggle]').forEach((input) => {
    input.onchange = () => toggleTool(input);
  });
}

async function toggleTool(input) {
  const tool = tools.find((item) => item.name === input.dataset.toolToggle);
  try {
    await send(`/tools/${encodeURIComponent(tool.name)}`, 'PATCH', { enabled: input.checked });
    tool.enabled = input.checked;
    toast(`${tool.title || tool.name} ${input.checked ? 'enabled' : 'disabled'}`);
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message, true);
  }
}
