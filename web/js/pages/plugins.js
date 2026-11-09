import { request, send } from '../api.js';
import { escapeHtml, pageHeader, toast, copyText } from '../ui.js';

let view;
let statusData;
let plugins = [];
let recipes = [];
let details = new Map();
let expanded = new Set();
let selectedRecipe;
let pollTimer;
let polling = false;

export async function renderPlugins(root, status) {
  view = root;
  statusData = status;
  plugins = await request('/plugins');
  recipes = await request('/plugins/recipes');
  view.innerHTML = `${pageHeader('PLUGIN TOOLS', 'Plugins', 'Connect external MCP servers and choose which tools they publish.',
    '<button class="button button-primary" id="add-plugin">Add plugin</button>')}
    <section class="panel plugins-connect">
      <div><p class="eyebrow">PLUGIN MCP ENDPOINT</p><h2>Connect a second app</h2>
        <p>Add this as a second app in your AI client to use plugin tools.</p></div>
      <div class="plugins-url-row"><code id="plugins-url"></code><button class="button button-small" id="copy-plugins-url">Copy</button></div>
    </section>
    <div class="plugins-list" id="plugins-list"></div>
    <dialog id="plugin-dialog" class="dialog plugin-dialog" aria-labelledby="plugin-dialog-title">
      <div>
        <div class="dialog-header"><div><p class="eyebrow">PLUGIN LIBRARY</p><h2 id="plugin-dialog-title">Add a plugin</h2></div>
          <button type="button" class="icon-button" id="close-plugin-dialog" aria-label="Close">×</button></div>
        <div class="tabs" role="tablist" aria-label="Plugin setup method">
          <button type="button" class="tab active" data-plugin-tab="recipe" role="tab" aria-selected="true">Recipes</button>
          <button type="button" class="tab" data-plugin-tab="custom" role="tab" aria-selected="false">Custom</button>
        </div>
        <div id="recipe-panel" class="plugin-dialog-panel"></div>
        <div id="custom-panel" class="plugin-dialog-panel" hidden>
          <form id="custom-form">
          <label>Plugin name<input name="custom-name" required maxlength="80" placeholder="My plugin"></label>
          <label>Transport<select name="transport-type"><option value="stdio">Local process (stdio)</option><option value="http">Streamable HTTP</option></select></label>
          <div id="custom-stdio">
            <label>Command<input name="command" placeholder="npx" autocomplete="off"></label>
            <label>Arguments, one per line<textarea name="args" rows="3" placeholder="-y&#10;@example/mcp-server"></textarea></label>
            <label>Environment variables, KEY=value per line<textarea name="env" rows="3" autocomplete="off" placeholder="API_KEY=your-secret"></textarea></label>
          </div>
          <div id="custom-http" hidden>
            <label>URL<input name="url" type="url" placeholder="https://example.com/mcp"></label>
            <label>Headers, one KEY=value per line<textarea name="headers" rows="3" autocomplete="off" placeholder="Authorization=Bearer your-token"></textarea></label>
          </div>
          <button class="button button-primary" type="submit" data-submit-plugin="custom">Add plugin</button>
          </form>
        </div>
      </div>
    </dialog>`;
  const endpoint = statusData?.endpoints?.pluginsUrlWithToken || '';
  view.querySelector('#plugins-url').textContent = endpoint || 'Plugin endpoint unavailable';
  view.querySelector('#copy-plugins-url').disabled = !endpoint;
  view.querySelector('#copy-plugins-url').onclick = () => copyText(endpoint, 'Plugin MCP URL copied');
  view.querySelector('#add-plugin').onclick = openAddDialog;
  view.querySelector('#close-plugin-dialog').onclick = closeAddDialog;
  view.querySelector('#plugin-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeAddDialog();
  });
  view.querySelector('#plugin-dialog').addEventListener('submit', handlePluginSubmit);
  view.querySelector('#plugin-dialog').addEventListener('click', handleDialogClick);
  view.querySelector('[name="transport-type"]').onchange = drawCustomTransport;
  view.querySelector('#plugins-list').addEventListener('click', handlePluginClick);
  view.querySelector('#plugins-list').addEventListener('change', handlePluginChange);
  view.querySelector('#plugins-list').addEventListener('toggle', handleDetailsToggle, true);
  drawPlugins();
  pollTimer = setInterval(refreshPlugins, 3000);
}

export function closePluginsPage() {
  clearInterval(pollTimer);
  pollTimer = undefined;
  view = undefined;
  polling = false;
}

async function refreshPlugins() {
  if (!view || polling || location.hash.slice(1) !== 'plugins') return;
  polling = true;
  try {
    plugins = await request('/plugins');
    const currentIds = new Set(plugins.map((plugin) => plugin.id));
    for (const id of [...expanded]) if (!currentIds.has(id)) expanded.delete(id);
    await Promise.all([...expanded].map(async (id) => {
      try { details.set(id, await request(`/plugins/${encodeURIComponent(id)}`)); }
      catch { details.delete(id); }
    }));
    drawPlugins();
  } catch {
    // Keep the last known state visible while the API is temporarily unavailable.
  } finally {
    polling = false;
  }
}

function drawPlugins() {
  if (!view) return;
  view.querySelector('#plugins-list').innerHTML = plugins.length
    ? plugins.map(renderPlugin).join('')
    : '<div class="panel plugin-empty"><strong>No plugins installed</strong><p>Add a recipe or configure a custom MCP server.</p></div>';
}

function renderPlugin(plugin) {
  const detail = details.get(plugin.id);
  const status = plugin.status || {};
  const state = ['ready', 'starting', 'error', 'disabled'].includes(status.state) ? status.state : 'error';
  const label = { ready: 'Ready', starting: 'Starting', error: 'Error', disabled: 'Disabled' }[state];
  const transportLabel = plugin.transport?.type === 'http' ? 'Streamable HTTP' : 'stdio';
  const tools = detail?.tools || [];
  const stderr = status.stderrTail || detail?.status?.stderrTail || [];
  return `<article class="panel plugin-card">
    <div class="plugin-card-top"><div class="plugin-title"><h2>${escapeHtml(plugin.name)}</h2>
      <span class="plugin-state state-${state}">${label}</span><span class="plugin-transport">${transportLabel}</span></div>
      <div class="plugin-actions"><button class="button button-small" data-plugin-action="restart" data-plugin-id="${escapeHtml(plugin.id)}">Restart</button>
        <button class="button button-small button-danger" data-plugin-action="remove" data-plugin-id="${escapeHtml(plugin.id)}">Remove</button></div></div>
    ${status.error ? `<p class="plugin-error">${escapeHtml(status.error)}</p>` : ''}
    <div class="plugin-summary-row"><span><strong>${Number(status.publishedCount) || 0}</strong> / ${Number(status.toolCount) || 0} tools published</span>
      <label class="switch-label">Enabled <label class="switch"><input type="checkbox" data-plugin-toggle="enabled" data-plugin-id="${escapeHtml(plugin.id)}" ${plugin.enabled ? 'checked' : ''}><span></span><em class="sr-only">Enable ${escapeHtml(plugin.name)}</em></label></label>
      <label class="switch-label">Trusted <label class="switch"><input type="checkbox" data-plugin-toggle="trusted" data-plugin-id="${escapeHtml(plugin.id)}" ${plugin.trusted ? 'checked' : ''}><span></span><em class="sr-only">Trust ${escapeHtml(plugin.name)}</em></label></label></div>
    <p class="plugin-trust-warning">Trusted mode removes approval prompts for this plugin’s tools.</p>
    <details class="plugin-tools-details" data-plugin-details="${escapeHtml(plugin.id)}" ${expanded.has(plugin.id) ? 'open' : ''}>
      <summary>Tools <span>${Number(status.toolCount) || 0}</span></summary>
      ${detail ? renderPluginTools(tools, plugin.id) : '<p class="muted plugin-loading">Loading tools…</p>'}
    </details>
    ${stderr.length ? `<details class="plugin-log"><summary>Recent stderr <span>${stderr.length} lines</span></summary><pre>${escapeHtml(stderr.join('\n'))}</pre></details>` : ''}
  </article>`;
}

function renderPluginTools(tools, pluginId) {
  if (!tools.length) return '<p class="muted plugin-loading">No tools declared by this plugin.</p>';
  return `<ul class="plugin-tool-list">${tools.map((tool) => `<li class="plugin-tool">
    <div><strong>${escapeHtml(tool.name)}</strong><p>${escapeHtml(tool.description || 'No description')}</p>
      ${!tool.published && ['limit', 'conflict'].includes(tool.reason)
        ? `<small class="plugin-unpublished">Not published: ${escapeHtml(tool.reason)}</small>` : ''}</div>
    <label class="switch"><input type="checkbox" data-plugin-tool="${escapeHtml(tool.name)}" data-plugin-id="${escapeHtml(pluginId)}" ${tool.enabled ? 'checked' : ''}><span></span><em class="sr-only">Enable ${escapeHtml(tool.name)}</em></label>
  </li>`).join('')}</ul>`;
}

async function handleDetailsToggle(event) {
  const detailsEl = event.target;
  if (!(detailsEl instanceof HTMLDetailsElement) || !detailsEl.matches('[data-plugin-details]')) return;
  const id = detailsEl.dataset.pluginDetails;
  if (detailsEl.open) {
    expanded.add(id);
    if (!details.has(id)) {
      details.set(id, await request(`/plugins/${encodeURIComponent(id)}`).catch(() => null));
      if (!view) return;
      drawPlugins();
    }
  } else expanded.delete(id);
}

async function handlePluginClick(event) {
  const button = event.target.closest('[data-plugin-action]');
  if (!button) return;
  const { pluginId, pluginAction } = button.dataset;
  button.disabled = true;
  try {
    if (pluginAction === 'remove') {
      const plugin = plugins.find((item) => item.id === pluginId);
      if (!window.confirm(`Remove ${plugin?.name || 'this plugin'}?`)) return;
      await request(`/plugins/${encodeURIComponent(pluginId)}`, { method: 'DELETE' });
      plugins = plugins.filter((item) => item.id !== pluginId);
      expanded.delete(pluginId);
      details.delete(pluginId);
      toast('Plugin removed');
    } else {
      const updated = await send(`/plugins/${encodeURIComponent(pluginId)}/restart`, 'POST');
      replacePlugin(updated);
      toast('Plugin restarted');
    }
    drawPlugins();
  } catch (error) {
    toast(error.message || 'Plugin action failed', true);
    button.disabled = false;
  }
}

async function handlePluginChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const id = input.dataset.pluginId;
  try {
    if (input.dataset.pluginToggle) {
      const key = input.dataset.pluginToggle;
      const updated = await send(`/plugins/${encodeURIComponent(id)}`, 'PATCH', { [key]: input.checked });
      replacePlugin(updated);
      toast(`${key === 'trusted' ? 'Trusted mode' : 'Plugin'} ${input.checked ? 'enabled' : 'disabled'}`);
    } else if (input.dataset.pluginTool) {
      const tool = input.dataset.pluginTool;
      const updated = await send(`/plugins/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}`, 'PATCH', { enabled: input.checked });
      const detail = details.get(id);
      if (detail) detail.tools = detail.tools.map((item) => item.name === tool ? updated : item);
      toast(`Tool ${input.checked ? 'enabled' : 'disabled'}`);
    }
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message || 'Could not update plugin', true);
  }
}

function replacePlugin(updated) {
  const index = plugins.findIndex((item) => item.id === updated.id);
  if (index >= 0) plugins[index] = updated;
  else plugins.unshift(updated);
}

function openAddDialog() {
  selectedRecipe = undefined;
  drawRecipePanel();
  const dialog = view.querySelector('#plugin-dialog');
  dialog.querySelector('[data-plugin-tab="recipe"]').click();
  dialog.showModal();
}

function closeAddDialog() {
  const dialog = view?.querySelector('#plugin-dialog');
  if (dialog?.open) dialog.close();
}

function handleDialogClick(event) {
  const tab = event.target.closest('[data-plugin-tab]');
  if (tab) {
    const recipeTab = tab.dataset.pluginTab === 'recipe';
    view.querySelectorAll('[data-plugin-tab]').forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    view.querySelector('#recipe-panel').hidden = !recipeTab;
    view.querySelector('#custom-panel').hidden = recipeTab;
    return;
  }
  const recipeCard = event.target.closest('[data-recipe-id]');
  if (recipeCard) {
    selectedRecipe = recipes.find((item) => item.id === recipeCard.dataset.recipeId);
    drawRecipePanel();
  }
}

function drawRecipePanel() {
  const panel = view.querySelector('#recipe-panel');
  if (!selectedRecipe) {
    panel.innerHTML = `<div class="recipe-grid">${recipes.map((recipe) => `<button type="button" class="recipe-card" data-recipe-id="${escapeHtml(recipe.id)}">
      <strong>${escapeHtml(recipe.name)}</strong><span>${escapeHtml(recipe.description)}</span>
      <small>${escapeHtml(recipe.runtime)} runtime${recipe.notes ? ` · ${escapeHtml(recipe.notes)}` : ''}</small></button>`).join('')}</div>
      ${recipes.length ? '' : '<p class="muted">No recipes are available. Configure a custom plugin instead.</p>'}`;
    return;
  }
  panel.innerHTML = `<button type="button" class="link-button" data-back-recipes>← All recipes</button>
    <div class="recipe-selected"><h3>${escapeHtml(selectedRecipe.name)}</h3><p>${escapeHtml(selectedRecipe.description)}</p>
      <small>${escapeHtml(selectedRecipe.runtime)} runtime${selectedRecipe.notes ? ` · ${escapeHtml(selectedRecipe.notes)}` : ''}</small></div>
    <form id="recipe-form"><label>Display name<input name="name" value="${escapeHtml(selectedRecipe.name)}" required maxlength="80"></label>
      ${(selectedRecipe.secrets || []).map((secret, index) => `<label>${escapeHtml(secret.label)}${secret.required ? ' *' : ' (optional)'}
        <input type="password" name="secret-${index}" autocomplete="new-password" ${secret.required ? 'required' : ''}>
        ${secret.help ? `<small class="field-help">${escapeHtml(secret.help)}</small>` : ''}</label>`).join('')}
      <button class="button button-primary" type="submit" data-submit-plugin="recipe">Add plugin</button></form>`;
  panel.querySelector('[data-back-recipes]').onclick = () => { selectedRecipe = undefined; drawRecipePanel(); };
}

function drawCustomTransport() {
  const type = view.querySelector('[name="transport-type"]').value;
  view.querySelector('#custom-stdio').hidden = type !== 'stdio';
  view.querySelector('#custom-http').hidden = type !== 'http';
}

async function handlePluginSubmit(event) {
  const submitter = event.submitter;
  const mode = submitter?.dataset.submitPlugin;
  if (!mode) return;
  event.preventDefault();
  submitter.disabled = true;
  try {
    const form = event.target;
    let input;
    if (mode === 'recipe') {
      if (!selectedRecipe) return;
      const transport = structuredClone(selectedRecipe.transport);
      for (const [index, secret] of (selectedRecipe.secrets || []).entries()) {
        const value = String(new FormData(form).get(`secret-${index}`) || '');
        if (!value) continue;
        const target = secret.where === 'header' ? (transport.headers ||= {}) : (transport.env ||= {});
        target[secret.key] = `${secret.prefix || ''}${value}`;
      }
      input = { name: new FormData(form).get('name'), recipe: selectedRecipe.id, transport };
    } else {
      const data = new FormData(form);
      const type = data.get('transport-type');
      input = {
        name: data.get('custom-name'),
        transport: type === 'stdio'
          ? { type, command: String(data.get('command') || '').trim(), args: lines(data.get('args')), env: parsePairs(data.get('env')) }
          : { type, url: String(data.get('url') || '').trim(), headers: parsePairs(data.get('headers')) },
      };
      if (!input.transport.command && type === 'stdio') throw new Error('Enter a command.');
      if (!input.transport.url && type === 'http') throw new Error('Enter a URL.');
    }
    const created = await send('/plugins', 'POST', input);
    replacePlugin(created);
    details.delete(created.id);
    closeAddDialog();
    drawPlugins();
    toast('Plugin added');
    await refreshPlugins();
  } catch (error) {
    toast(error.message || 'Could not add plugin', true);
  } finally {
    if (submitter.isConnected) submitter.disabled = false;
  }
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parsePairs(value) {
  const result = {};
  for (const line of lines(value)) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Use KEY=value for each environment variable or header.');
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}
