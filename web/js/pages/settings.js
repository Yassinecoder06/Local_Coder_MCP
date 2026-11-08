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

export async function renderSettings(view, status) {
  statusData = status;
  settings = await request('/settings');
  const approvalMode = settings.approvalMode || status.approvalMode || 'minimal';
  savedApprovalMode = approvalMode;
  const toolProfile = settings.toolProfile || status.toolProfile || 'essential';
  savedToolProfile = toolProfile;
  const roots = status.workspaceRoots || [];
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
          <span><strong>Trust</strong><small>Never ask. Every tool runs without confirmation in ChatGPT and Gemini.</small></span>
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
      <p>Folders this server can access. Managed in your server configuration.</p></div>
      <ul class="root-list">${roots.length ? roots.map((root) => `<li><span class="root-icon">⌂</span>
        <code>${escapeHtml(root)}</code>${root === status.defaultWorkspace
          ? '<span class="badge badge-current">Default</span>' : ''}</li>`).join('')
        : '<li class="muted">No workspace roots configured.</li>'}</ul>
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
