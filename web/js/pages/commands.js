import { request, send } from '../api.js';
import { confirmAction, escapeHtml, pageHeader, sourceBadge, toast } from '../ui.js';

let commands = [];

export async function renderCommands(view) {
  commands = await request('/commands');
  view.innerHTML = `${pageHeader(
    'REUSABLE PROMPTS',
    'Commands',
    'Reusable prompt templates available to your AI clients.',
    '<button class="button button-primary" id="add-command">＋ New command</button>',
  )}<div class="item-list" id="command-list"></div>`;
  drawCommands(view);
  view.querySelector('#add-command').onclick = () => editCommand(view);
}

function drawCommands(view) {
  const host = view.querySelector('#command-list');
  if (!commands.length) {
    host.innerHTML = `<div class="empty-state"><div class="empty-icon">⌁</div><h2>No commands yet</h2>
      <p>Create a reusable prompt for common tasks.</p>
      <button class="button button-primary" id="empty-command">Create command</button></div>`;
    host.querySelector('#empty-command').onclick = () => editCommand(view);
    return;
  }

  host.innerHTML = commands.map((command) => `<article class="list-card command-row">
    <button class="item-main" data-edit-command="${escapeHtml(command.name)}">
      <span class="item-icon command-icon">⌁</span><span class="item-copy">
        <strong>${escapeHtml(command.name)}</strong><span>${escapeHtml(command.description || 'No description')}
        ${command.args?.length ? ` · Args: ${escapeHtml(command.args.join(', '))}` : ''}</span>
      </span>
    </button><div class="item-actions">${sourceBadge(command.source)}
      ${command.editable ? `<button class="button button-small" data-edit-command="${escapeHtml(command.name)}">Edit</button>
        <button class="icon-button danger-icon" data-delete-command="${escapeHtml(command.name)}"
          aria-label="Delete ${escapeHtml(command.name)}">⌫</button>` : ''}
    </div></article>`).join('');
  host.querySelectorAll('[data-edit-command]').forEach((button) => {
    button.onclick = () => editCommand(view, button.dataset.editCommand);
  });
  host.querySelectorAll('[data-delete-command]').forEach((button) => {
    button.onclick = () => deleteCommand(view, button.dataset.deleteCommand);
  });
}

async function deleteCommand(view, name) {
  if (!confirmAction(`Delete command “${name}”?`)) return;
  try {
    await send(`/commands/${encodeURIComponent(name)}`, 'DELETE');
    commands = commands.filter((command) => command.name !== name);
    drawCommands(view);
    toast('Command deleted');
  } catch (error) {
    toast(error.message, true);
  }
}

async function editCommand(view, name = '') {
  let command = { name: '', description: '', args: [], template: '' };
  if (name) {
    try {
      command = await request(`/commands/${encodeURIComponent(name)}`);
    } catch (error) {
      toast(error.message, true);
      return;
    }
  }

  view.innerHTML = `${pageHeader(
    name ? 'COMMANDS' : 'NEW COMMAND',
    name ? `Edit ${escapeHtml(command.name)}` : 'Create a command',
    'Use {{argument}} placeholders in your template.',
    '<button class="button" id="cancel-command">← All commands</button>',
  )}
  <form id="command-form" class="panel editor-form">
    <label>Name<input name="name" required pattern="[a-z0-9][a-z0-9\\-]{0,63}"
      value="${escapeHtml(command.name)}" ${name ? 'readonly' : ''} placeholder="review"></label>
    <label>Description<input name="description" required value="${escapeHtml(command.description)}"
      placeholder="Review uncommitted changes"></label>
    <label>Arguments <span class="muted">(comma separated)</span><input name="args"
      value="${escapeHtml((command.args || []).join(', '))}" placeholder="focus, files"></label>
    <label>Template<textarea name="template" rows="12" required
      placeholder="Review the changes. Focus on {{focus}}.">${escapeHtml(command.template)}</textarea></label>
    <div class="form-actions"><button type="button" class="button" id="cancel-command-form">Cancel</button>
      <button class="button button-primary" type="submit">Save command</button></div>
  </form>`;
  view.querySelectorAll('#cancel-command, #cancel-command-form').forEach((button) => {
    button.onclick = () => navigateTo('commands');
  });
  view.querySelector('#command-form').onsubmit = (event) => saveCommand(event, view);
}

async function saveCommand(event, view) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  try {
    await send('/commands', 'POST', {
      name: fields.get('name'),
      description: fields.get('description'),
      args: fields.get('args').split(',').map((arg) => arg.trim()).filter(Boolean),
      template: fields.get('template'),
    });
    toast('Command saved');
    commands = await request('/commands');
    await renderCommands(view);
  } catch (error) {
    toast(error.message, true);
  }
}
