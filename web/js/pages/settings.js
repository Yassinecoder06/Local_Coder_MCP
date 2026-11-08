import { request, send } from '../api.js';
import { escapeHtml, pageHeader, toast } from '../ui.js';

let settings = {};
let statusData = {};

export async function renderSettings(view, status) {
  statusData = status;
  settings = await request('/settings');
  const approvalMode = settings.approvalMode || status.approvalMode || 'minimal';
  const toolProfile = settings.toolProfile || status.toolProfile || 'essential';
  const roots = status.workspaceRoots || [];
  view.innerHTML = `${pageHeader(
    'PREFERENCES',
    'Settings',
    'Tune the default behavior of your Local Coder server.',
  )}
  <div class="settings-stack">
    <section class="panel setting-section"><div class="setting-copy"><h2>Approval mode</h2>
      <p>Choose how much confirmation is needed before actions run.</p></div>
      <div class="radio-cards">
        <label class="radio-card ${approvalMode === 'minimal' ? 'selected' : ''}">
          <input type="radio" name="approvalMode" value="minimal" ${approvalMode === 'minimal' ? 'checked' : ''}>
          <span><strong>Minimal</strong><small>Ask only when an action needs extra confirmation. Best for a smooth workflow.</small></span>
        </label>
        <label class="radio-card ${approvalMode === 'standard' ? 'selected' : ''}">
          <input type="radio" name="approvalMode" value="standard" ${approvalMode === 'standard' ? 'checked' : ''}>
          <span><strong>Standard</strong><small>Use a more cautious approval level for write and execution actions.</small></span>
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
    });
  });
  view.querySelector('#save-settings').onclick = () => saveSettings(view);
}

async function saveSettings(view) {
  const patch = {
    approvalMode: view.querySelector('[name="approvalMode"]:checked').value,
    toolProfile: view.querySelector('[name="toolProfile"]:checked').value,
  };
  try {
    settings = await send('/settings', 'PATCH', patch);
    statusData.approvalMode = settings.approvalMode;
    statusData.toolProfile = settings.toolProfile;
    toast('Settings saved');
  } catch (error) {
    toast(error.message, true);
  }
}
