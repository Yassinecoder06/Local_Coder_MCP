import { request, send } from '../api.js';
import { confirmAction, escapeHtml, pageHeader, sourceBadge, toast } from '../ui.js';
import { navigateTo } from '../router.js';

let skills = [];
let pendingFiles = {};

export async function renderSkills(view) {
  skills = await request('/skills');
  view.innerHTML = `${pageHeader(
    'CAPABILITIES',
    'Skills',
    'Give your AI clients repeatable workflows and project knowledge.',
    '<button class="button button-primary" id="add-skill">＋ Add skill</button>',
  )}
  <div class="toolbar"><label class="searchbox"><span>⌕</span>
    <input id="skill-search" type="search" placeholder="Search skills by name or description…" aria-label="Search skills">
  </label><span class="count-label">${skills.length} skills</span></div>
  <div id="skill-list" class="item-list"></div>`;
  drawSkills(view);
  view.querySelector('#add-skill').onclick = openSkillDrawer;
  view.querySelector('#skill-search').oninput = () => drawSkills(view);
}

function drawSkills(view) {
  const query = view.querySelector('#skill-search').value.toLowerCase();
  const filtered = skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
  const host = view.querySelector('#skill-list');
  if (!filtered.length) {
    host.innerHTML = `<div class="empty-state"><div class="empty-icon">✳</div>
      <h2>${query ? 'No matching skills' : 'No skills yet'}</h2>
      <p>${query ? 'Try another search.' : 'Add a skill to teach your clients a repeatable workflow.'}</p>
      ${query ? '' : '<button class="button button-primary" id="empty-add">Add your first skill</button>'}</div>`;
    host.querySelector('#empty-add')?.addEventListener('click', openSkillDrawer);
    return;
  }

  host.innerHTML = filtered.map((skill) => `<article class="list-card skill-row">
    <button class="item-main" data-view-skill="${escapeHtml(skill.name)}">
      <span class="item-icon">✳</span><span class="item-copy"><strong>${escapeHtml(skill.name)}</strong>
      <span>${escapeHtml(skill.description || 'No description')}</span></span>
    </button><div class="item-actions">${sourceBadge(skill.source)}
      <label class="switch" title="${skill.enabled ? 'Disable' : 'Enable'} ${escapeHtml(skill.name)}">
        <input type="checkbox" data-skill-toggle="${escapeHtml(skill.name)}" ${skill.enabled ? 'checked' : ''}>
        <span></span><em class="sr-only">Enable skill</em>
      </label>
      ${skill.editable ? `<button class="icon-button danger-icon" data-delete-skill="${escapeHtml(skill.name)}"
        aria-label="Delete ${escapeHtml(skill.name)}">⌫</button>` : ''}
    </div></article>`).join('');

  host.querySelectorAll('[data-view-skill]').forEach((button) => {
    button.onclick = () => viewSkill(view, button.dataset.viewSkill);
  });
  host.querySelectorAll('[data-skill-toggle]').forEach((input) => {
    input.onchange = () => toggleSkill(input);
  });
  host.querySelectorAll('[data-delete-skill]').forEach((button) => {
    button.onclick = () => deleteSkill(view, button.dataset.deleteSkill);
  });
}

async function toggleSkill(input) {
  try {
    await send(`/skills/${encodeURIComponent(input.dataset.skillToggle)}`, 'PATCH', {
      enabled: input.checked,
    });
    const skill = skills.find((item) => item.name === input.dataset.skillToggle);
    if (skill) skill.enabled = input.checked;
    toast(`Skill ${input.checked ? 'enabled' : 'disabled'}`);
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message, true);
  }
}

async function deleteSkill(view, name) {
  if (!await confirmAction(`Delete skill “${name}”?`, {
    title: 'Delete skill?',
    confirmLabel: 'Delete skill',
  })) return;
  try {
    await send(`/skills/${encodeURIComponent(name)}`, 'DELETE');
    skills = skills.filter((skill) => skill.name !== name);
    drawSkills(view);
    toast('Skill deleted');
  } catch (error) {
    toast(error.message, true);
  }
}

async function viewSkill(view, name) {
  try {
    const skill = await request(`/skills/${encodeURIComponent(name)}`);
    view.innerHTML = `${pageHeader(
      'SKILL DETAILS',
      escapeHtml(skill.name),
      escapeHtml(skill.description),
      '<button class="button" id="back-skills">← All skills</button>',
    )}
    <div class="detail-meta">${sourceBadge(skill.source)}<span>${skill.enabled ? 'Enabled' : 'Disabled'}</span>
      <span>${(skill.files || []).length} files</span></div>
    <div class="detail-grid"><article class="panel"><h2>SKILL.md</h2>
      <pre class="body-text">${escapeHtml(skill.body || '')}</pre></article>
      <article class="panel"><h2>Files</h2>${skill.files?.length
        ? `<ul class="file-list-view">${skill.files.map((file) => `<li><span>▤</span>${escapeHtml(file)}</li>`).join('')}</ul>`
        : '<p class="muted">No additional files.</p>'}</article></div>`;
    view.querySelector('#back-skills').onclick = () => navigateTo('skills');
  } catch (error) {
    toast(error.message, true);
  }
}

function openSkillDrawer() {
  pendingFiles = {};
  document.querySelector('#skill-form').reset();
  document.querySelector('#skill-markdown').value = '';
  document.querySelector('#skill-path').value = '';
  document.querySelector('#file-list').replaceChildren();
  document.querySelector('#skill-dialog').showModal();
  selectSkillTab('write');
}

function selectSkillTab(tab) {
  document.querySelectorAll('#skill-dialog [data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('#skill-dialog [data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

async function saveWrittenSkill(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await send('/skills', 'POST', {
      name: form.get('name'),
      description: form.get('description'),
      body: form.get('body'),
    });
    document.querySelector('#skill-dialog').close();
    toast('Skill saved');
    await renderSkills(document.querySelector('#view'));
  } catch (error) {
    toast(error.message, true);
  }
}

async function importPastedSkill() {
  const markdown = document.querySelector('#skill-markdown').value;
  if (!markdown.trim()) return toast('Paste SKILL.md content first', true);
  try {
    await send('/skills/import', 'POST', { markdown, files: pendingFiles });
    document.querySelector('#skill-dialog').close();
    toast('Skill imported');
    await renderSkills(document.querySelector('#view'));
  } catch (error) {
    toast(error.message, true);
  }
}

async function importSkillPath() {
  const path = document.querySelector('#skill-path').value.trim();
  if (!path) return toast('Enter an absolute folder path', true);
  try {
    await send('/skills/import', 'POST', { path });
    document.querySelector('#skill-dialog').close();
    toast('Skill imported');
    await renderSkills(document.querySelector('#view'));
  } catch (error) {
    toast(error.message, true);
  }
}

async function readReferenceFiles(fileList) {
  for (const file of fileList) {
    try {
      pendingFiles[file.webkitRelativePath || file.name] = await file.text();
    } catch {
      toast(`Could not read ${file.name}`, true);
    }
  }
  document.querySelector('#file-list').innerHTML = Object.keys(pendingFiles)
    .map((name) => `<span class="file-chip">▤ ${escapeHtml(name)}</span>`).join('');
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('#skill-dialog [data-tab]');
  if (tab) selectSkillTab(tab.dataset.tab);
  if (event.target.closest('[data-close-dialog]')) document.querySelector('#skill-dialog').close();
});
document.querySelector('#skill-form').addEventListener('submit', saveWrittenSkill);
document.querySelector('#skill-files').addEventListener('change', (event) => readReferenceFiles(event.target.files));
document.querySelector('#file-drop').addEventListener('dragover', (event) => {
  event.preventDefault();
  event.currentTarget.classList.add('dragover');
});
document.querySelector('#file-drop').addEventListener('dragleave', (event) => {
  event.currentTarget.classList.remove('dragover');
});
document.querySelector('#file-drop').addEventListener('drop', (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove('dragover');
  readReferenceFiles(event.dataTransfer.files);
});
document.querySelector('#import-markdown').addEventListener('click', importPastedSkill);
document.querySelector('#import-path').addEventListener('click', importSkillPath);
