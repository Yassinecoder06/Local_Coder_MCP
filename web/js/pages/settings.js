import { request, send } from '../api.js';
import {
  escapeHtml,
  integrationsCard,
  pageHeader,
  toast,
  trapDialogFocus,
} from '../ui.js';

let settings = {};
let statusData = {};
let savedApprovalMode = 'minimal';
let savedToolProfile = 'essential';
let trustTrigger;
let trustSavePending = false;
let workspaceRoots = [];
let savedWorkspaceRoots = [];
let defaultWorkspace = '';
let workspaceSource = 'env';
let mountDirs = [];
let pickerBasePath = '';
let pickerPath = '';
let pickerParent = '';

export async function renderSettings(view, status) {
  statusData = status;
  settings = await request('/settings');
  const approvalMode = settings.approvalMode || status.approvalMode || 'minimal';
  savedApprovalMode = approvalMode;
  const toolProfile = settings.toolProfile || status.toolProfile || 'essential';
  savedToolProfile = toolProfile;
  workspaceRoots = [...(status.workspaceRoots || [])];
  savedWorkspaceRoots = [...workspaceRoots];
  defaultWorkspace = status.defaultWorkspace || workspaceRoots[0] || '';
  workspaceSource = status.workspaceSource || 'env';
  mountDirs = status.mountDirs || [];
  view.innerHTML = `${pageHeader(
    'PREFERENCES',
    'Settings',
    'Tune the default behavior of your Local Coder server.',
  )}
  <div class="settings-stack">
    ${integrationsCard(status.integrations)}
    <section class="panel setting-section"><div class="setting-copy"><h2>Approval mode</h2>
      <p>Choose how much confirmation is needed before actions run.</p></div>
      <div class="radio-cards approval-options">
        <label class="radio-card ${approvalMode === 'trust' ? 'selected' : ''}">
          <input type="radio" name="approvalMode" value="trust" ${approvalMode === 'trust' ? 'checked' : ''}>
          <span><strong>Trust</strong><small>Never ask. Every tool runs without confirmation in connected clients.</small></span>
        </label>
        <label class="radio-card ${approvalMode === 'minimal' ? 'selected' : ''}">
          <input type="radio" name="approvalMode" value="minimal" ${approvalMode === 'minimal' ? 'checked' : ''}>
          <span><strong>Minimal (recommended)</strong><small>One-time Always allow per tool; read-only tools never ask.</small></span>
        </label>
        <label class="radio-card ${approvalMode === 'standard' ? 'selected' : ''}">
          <input type="radio" name="approvalMode" value="standard" ${approvalMode === 'standard' ? 'checked' : ''}>
          <span><strong>Standard</strong><small>Clients may ask every time.</small></span>
        </label>
      </div>
    </section>
    <section class="panel setting-section"><div class="setting-copy"><h2>Tool profile</h2>
      <p>Set the default group of tools available to clients.</p></div>
      <div class="radio-cards compact-radio">
        <label class="radio-card ${toolProfile === 'essential' ? 'selected' : ''}">
          <input type="radio" name="toolProfile" value="essential" ${toolProfile === 'essential' ? 'checked' : ''}>
          <span><strong>Essential</strong><small>Core daily workspace tools.</small></span>
        </label>
        <label class="radio-card ${toolProfile === 'full' ? 'selected' : ''}">
          <input type="radio" name="toolProfile" value="full" ${toolProfile === 'full' ? 'checked' : ''}>
          <span><strong>Full</strong><small>All available tools.</small></span>
        </label>
      </div>
    </section>
    <section class="panel setting-section roots-section"><div class="setting-copy"><h2>Workspace roots</h2>
      <p>Folders this server can access.</p>
      <p class="workspace-source">Current roots are <strong id="workspace-source-label">from ${workspaceSource === 'settings' ? 'settings' : '.env'}</strong>.</p></div>
      <p class="workspace-source janitor-status">${statusData.janitor?.at
        ? `${Number(statusData.janitor.cleaned) || 0} stale entries cleaned at ${new Date(statusData.janitor.at).toLocaleString()}`
        : 'No cleanup run recorded yet.'}</p>
      <div class="workspace-roots-editor">
        <ul class="root-list" id="workspace-root-list"></ul>
        <div class="workspace-root-actions"><button class="button button-small" id="add-workspace-root">Add folder</button>
          <button class="button button-small" id="reset-workspaces">Reset to .env</button>
          <button class="button button-primary button-small" id="save-workspaces">Save</button></div>
        <p class="workspace-root-note">Only folders inside ${mountDirs.length
          ? mountDirs.map((dir) => `<code>${escapeHtml(dir)}</code>`).join(', ')
          : '<code>(no mount directory configured)</code>'} are reachable. To reach others, set <code>MOUNT_DIR</code> in <code>.env</code> and run <code>make up</code>.</p>
        <p class="workspace-error" id="workspace-error" role="alert" hidden></p>
      </div>
      <dialog class="dialog folder-picker" id="folder-picker" aria-labelledby="folder-picker-title">
        <div class="dialog-header"><div><p class="eyebrow">WORKSPACE ROOT</p><h2 id="folder-picker-title">Choose a folder</h2></div>
          <button type="button" class="icon-button" id="close-folder-picker" aria-label="Close folder picker">×</button></div>
        <div id="folder-picker-content"></div>
        <p class="workspace-error" id="folder-picker-error" role="alert" hidden></p>
        <div class="dialog-actions folder-picker-actions"><button class="button" type="button" id="folder-picker-cancel">Cancel</button>
          <button class="button button-primary" type="button" id="use-folder" disabled>Use this folder</button></div>
      </dialog>
    </section>
    <div class="settings-save"><span id="settings-feedback" class="muted"></span>
      <button class="button button-primary" id="save-settings">Save settings</button></div>
  </div>`;
  view.querySelectorAll('input[name="approvalMode"], input[name="toolProfile"]').forEach((input) => {
    input.addEventListener('change', () => {
      input.closest('.radio-cards').querySelectorAll('.radio-card').forEach((card) => {
        card.classList.toggle('selected', card.querySelector('input').checked);
      });
      if (input.name === 'approvalMode' && input.value === 'trust'
        && savedApprovalMode !== 'trust') {
        trustTrigger = input;
        document.querySelector('#trust-confirm').disabled = false;
        document.querySelector('#trust-confirm-dialog').showModal();
      }
    });
  });
  view.querySelector('#save-settings').onclick = () => saveSettings(view);
  drawWorkspaceRoots(view);
  view.querySelector('#workspace-root-list').addEventListener('click', handleWorkspaceRootAction);
  view.querySelector('#add-workspace-root').onclick = openFolderPicker;
  view.querySelector('#save-workspaces').onclick = () => saveWorkspaces(view);
  view.querySelector('#reset-workspaces').onclick = () => resetWorkspaces(view);
  view.querySelector('#close-folder-picker').onclick = closeFolderPicker;
  view.querySelector('#folder-picker-cancel').onclick = closeFolderPicker;
  view.querySelector('#folder-picker-content').addEventListener('click', handlePickerAction);
  view.querySelector('#use-folder').onclick = useSelectedFolder;
  view.querySelector('#folder-picker').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeFolderPicker();
  });
}

function drawWorkspaceRoots(root) {
  const list = root.querySelector('#workspace-root-list');
  list.innerHTML = workspaceRoots.length ? workspaceRoots.map((path) => `<li>
    <span class="root-icon">⌂</span><code>${escapeHtml(path)}</code>
    ${path === defaultWorkspace
      ? '<span class="badge badge-current">Default</span>'
      : `<button type="button" class="link-button" data-root-default="${escapeHtml(path)}">Set default</button>`}
    <button type="button" class="root-remove" data-root-remove="${escapeHtml(path)}" aria-label="Remove ${escapeHtml(path)}">Remove</button>
  </li>`).join('') : '<li class="muted">No workspace roots configured. Add a folder to continue.</li>';
  const dirty = defaultWorkspace !== (statusData.defaultWorkspace || savedWorkspaceRoots[0] || '')
    || workspaceRoots.length !== savedWorkspaceRoots.length
    || workspaceRoots.some((path, index) => path !== savedWorkspaceRoots[index]);
  root.querySelector('#save-workspaces').disabled = !dirty;
  root.querySelector('#reset-workspaces').disabled = workspaceSource !== 'settings' && !dirty;
  root.querySelector('#workspace-source-label').textContent = `from ${workspaceSource === 'settings' ? 'settings' : '.env'}`;
}

function handleWorkspaceRootAction(event) {
  const setDefault = event.target.closest('[data-root-default]');
  const remove = event.target.closest('[data-root-remove]');
  if (setDefault) defaultWorkspace = setDefault.dataset.rootDefault;
  if (remove) {
    const path = remove.dataset.rootRemove;
    workspaceRoots = workspaceRoots.filter((root) => root !== path);
    if (defaultWorkspace === path) defaultWorkspace = workspaceRoots[0] || '';
  }
  if (setDefault || remove) drawWorkspaceRoots(view);
}

async function openFolderPicker() {
  const dialog = view.querySelector('#folder-picker');
  view.querySelector('#folder-picker-error').hidden = true;
  dialog.showModal();
  drawPickerRoots();
  // One mount folder: skip the "choose an area" step and start browsing it.
  const areas = mountDirs.length ? mountDirs : workspaceRoots;
  if (areas.length === 1) {
    pickerBasePath = areas[0];
    await loadPickerDirectory(pickerBasePath);
  }
}

function closeFolderPicker() {
  const dialog = view?.querySelector('#folder-picker');
  if (dialog?.open) dialog.close();
}

function drawPickerRoots() {
  pickerBasePath = '';
  pickerPath = '';
  const content = view.querySelector('#folder-picker-content');
  const areas = mountDirs.length ? mountDirs : workspaceRoots;
  content.innerHTML = areas.length
    ? `<p class="folder-picker-intro">Choose a mounted folder to browse.</p><div class="folder-area-list">${areas.map((path) => `<button class="folder-area" type="button" data-picker-root="${escapeHtml(path)}"><span class="root-icon">⌂</span><code>${escapeHtml(path)}</code></button>`).join('')}</div>`
    : '<p class="muted">No mount directories are available to browse.</p>';
  view.querySelector('#use-folder').disabled = true;
}

async function loadPickerDirectory(path) {
  const content = view.querySelector('#folder-picker-content');
  const error = view.querySelector('#folder-picker-error');
  error.hidden = true;
  content.innerHTML = '<div class="picker-loading">Loading folders…</div>';
  try {
    const directory = await request(`/fs/dirs?path=${encodeURIComponent(path)}`);
    pickerPath = directory.path;
    pickerParent = directory.parent || '';
    const crumbs = pickerPath.slice(pickerBasePath.length).split('/').filter(Boolean);
    let crumbPath = pickerBasePath;
    const crumbHtml = [`<button type="button" data-picker-path="${escapeHtml(pickerBasePath)}">${escapeHtml(pickerBasePath)}</button>`];
    for (const crumb of crumbs) {
      crumbPath = `${crumbPath.replace(/\/$/, '')}/${crumb}`;
      crumbHtml.push(`<span aria-hidden="true">/</span><button type="button" data-picker-path="${escapeHtml(crumbPath)}">${escapeHtml(crumb)}</button>`);
    }
    content.innerHTML = `<div class="folder-breadcrumb"><button type="button" data-picker-up ${!directory.parent || pickerPath === pickerBasePath ? 'disabled' : ''} aria-label="Go to parent folder">↑</button>
      <nav aria-label="Folder path">${crumbHtml.join('')}</nav></div>
      <ul class="folder-picker-list">${directory.dirs.length ? directory.dirs.map((dir) => `<li><button type="button" data-picker-path="${escapeHtml(dir.path)}"><span class="root-icon">⌂</span>
        <span>${escapeHtml(dir.name)}</span>${dir.isGitRepo ? '<span class="badge badge-current">Git repo</span>' : ''}<span class="folder-enter">Open ›</span></button></li>`).join('') : '<li class="muted picker-no-folders">No folders here.</li>'}</ul>`;
    view.querySelector('#use-folder').disabled = false;
  } catch (err) {
    content.innerHTML = '';
    error.textContent = err.message || 'Could not read folders.';
    error.hidden = false;
    view.querySelector('#use-folder').disabled = true;
  }
}

async function handlePickerAction(event) {
  const rootButton = event.target.closest('[data-picker-root]');
  const pathButton = event.target.closest('[data-picker-path]');
  const upButton = event.target.closest('[data-picker-up]');
  if (rootButton) {
    pickerBasePath = rootButton.dataset.pickerRoot;
    await loadPickerDirectory(pickerBasePath);
  } else if (pathButton) {
    await loadPickerDirectory(pathButton.dataset.pickerPath);
  } else if (upButton && !upButton.disabled) {
    if (pickerParent === pickerBasePath || pickerParent.startsWith(`${pickerBasePath.replace(/\/$/, '')}/`)) {
      await loadPickerDirectory(pickerParent);
    }
  }
}

function useSelectedFolder() {
  if (!pickerPath) return;
  if (!workspaceRoots.includes(pickerPath)) workspaceRoots.push(pickerPath);
  if (!defaultWorkspace) defaultWorkspace = pickerPath;
  drawWorkspaceRoots(view);
  closeFolderPicker();
}

async function saveWorkspaces(root) {
  const error = root.querySelector('#workspace-error');
  error.hidden = true;
  try {
    const payload = { roots: workspaceRoots, ...(defaultWorkspace ? { defaultWorkspace } : {}) };
    const result = await send('/workspaces', 'PUT', payload);
    workspaceRoots = [...result.roots];
    savedWorkspaceRoots = [...workspaceRoots];
    defaultWorkspace = result.defaultWorkspace || '';
    workspaceSource = result.source || 'settings';
    statusData.workspaceRoots = [...workspaceRoots];
    statusData.defaultWorkspace = defaultWorkspace;
    statusData.workspaceSource = workspaceSource;
    drawWorkspaceRoots(root);
    toast('Workspace roots saved');
  } catch (err) {
    error.textContent = err.message || 'Could not save workspace roots.';
    error.hidden = false;
  }
}

async function resetWorkspaces(root) {
  const error = root.querySelector('#workspace-error');
  error.hidden = true;
  try {
    await request('/workspaces', { method: 'DELETE' });
    const status = await request('/status');
    workspaceRoots = [...(status.workspaceRoots || [])];
    savedWorkspaceRoots = [...workspaceRoots];
    defaultWorkspace = status.defaultWorkspace || workspaceRoots[0] || '';
    workspaceSource = status.workspaceSource || 'env';
    statusData.workspaceRoots = [...workspaceRoots];
    statusData.defaultWorkspace = defaultWorkspace;
    statusData.workspaceSource = workspaceSource;
    drawWorkspaceRoots(root);
    toast('Workspace roots reset to .env');
  } catch (err) {
    error.textContent = err.message || 'Could not reset workspace roots.';
    error.hidden = false;
  }
}

async function saveSettings(view) {
  const patch = {
    approvalMode: view.querySelector('[name="approvalMode"]:checked').value,
    toolProfile: view.querySelector('[name="toolProfile"]:checked').value,
  };
  if (patch.approvalMode === savedApprovalMode
    && patch.toolProfile === savedToolProfile) return;
  try {
    settings = await send('/settings', 'PATCH', patch);
    savedApprovalMode = settings.approvalMode;
    savedToolProfile = settings.toolProfile;
    statusData.approvalMode = settings.approvalMode;
    statusData.toolProfile = settings.toolProfile;
    document.dispatchEvent(new CustomEvent('approval-mode:change', {
      detail: { mode: settings.approvalMode },
    }));
    toast('Settings saved');
  } catch (error) {
    toast(error.message, true);
  }
}

document.querySelector('#trust-cancel').addEventListener('click', () => {
  restoreApprovalMode();
  document.querySelector('#trust-confirm-dialog').close('cancel');
});

const trustDialog = document.querySelector('#trust-confirm-dialog');
trustDialog.addEventListener('cancel', restoreApprovalMode);
trustDialog.addEventListener('keydown', trapDialogFocus);

document.querySelector('#trust-confirm').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (trustSavePending) return;
  trustSavePending = true;
  button.disabled = true;
  try {
    settings = await send('/settings', 'PATCH', { approvalMode: 'trust' });
    savedApprovalMode = settings.approvalMode || 'trust';
    statusData.approvalMode = savedApprovalMode;
    document.dispatchEvent(new CustomEvent('approval-mode:change', {
      detail: { mode: savedApprovalMode },
    }));
    document.querySelector('#trust-confirm-dialog').close();
    toast('Trust mode enabled');
  } catch (error) {
    toast(error.message, true);
  } finally {
    trustSavePending = false;
    if (trustDialog.open) button.disabled = false;
  }
});

trustDialog.addEventListener('close', () => {
  restoreApprovalMode();
  const trigger = trustTrigger;
  trustTrigger = undefined;
  if (trigger?.isConnected) setTimeout(() => trigger.focus(), 0);
});

function restoreApprovalMode() {
  if (savedApprovalMode === 'trust') return;
  const selected = document.querySelector(
    `input[name="approvalMode"][value="${savedApprovalMode}"]`,
  );
  if (!selected) return;
  selected.checked = true;
  selected.closest('.radio-cards').querySelectorAll('.radio-card').forEach((card) => {
    card.classList.toggle('selected', card.querySelector('input').checked);
  });
}
