import { request } from './js/api.js';
import { setRouteListener } from './js/router.js';
import { toast } from './js/ui.js';
import { renderActivity, closeActivityStream } from './js/pages/activity.js';
import { renderCommands } from './js/pages/commands.js';
import { renderConnect } from './js/pages/connect.js';
import { renderSettings } from './js/pages/settings.js';
import { renderSkills } from './js/pages/skills.js';
import { renderTools } from './js/pages/tools.js';

const view = document.querySelector('#view');
const shell = document.querySelector('.shell');
const sidebarQuery = window.matchMedia('(max-width: 899px)');
let serverStatus;
let healthChecked = false;

async function renderRoute(route) {
  if (route !== 'activity') closeActivityStream();
  view.innerHTML = '<div class="skeleton skeleton-title"></div><div class="skeleton skeleton-card"></div>';

  try {
    serverStatus = await request('/status');
    setConnectionState(true);
    setTrustBadge(serverStatus.approvalMode);
    if (!healthChecked) {
      await refreshHealthIndicator();
      healthChecked = true;
    }
    const pages = {
      connect: () => renderConnect(view, serverStatus),
      skills: () => renderSkills(view),
      commands: () => renderCommands(view),
      tools: () => renderTools(view, serverStatus),
      activity: () => renderActivity(view),
      settings: () => renderSettings(view, serverStatus),
    };
    await pages[route]();
  } catch (error) {
    setConnectionState(false, error.message);
    view.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div>
      <h2>Couldn’t load this page</h2><p>${escapeHtml(error.message)}</p>
      <button class="button" id="page-retry">Try again</button></div>`;
    view.querySelector('#page-retry').onclick = () => renderRoute(route);
  }
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function setConnectionState(online, message = '') {
  const banner = document.querySelector('#error-banner');
  banner.hidden = online;
  if (!online) document.querySelector('#error-message').textContent = message;
  document.querySelector('#connection-dot').classList.toggle('offline', !online);
  document.querySelector('#connection-label').textContent = online ? 'Connected' : 'Offline';
}

document.querySelector('#retry-button').onclick = () => renderRoute(location.hash.slice(1) || 'connect');

function readSidebarPreference() {
  try {
    return localStorage.getItem('lc-sidebar-collapsed') === 'true';
  } catch {
    return false;
  }
}

function saveSidebarPreference(collapsed) {
  try {
    localStorage.setItem('lc-sidebar-collapsed', String(collapsed));
  } catch {
    // Sidebar behavior still works for this session when storage is unavailable.
  }
}

function syncSidebarControls() {
  const mobile = sidebarQuery.matches;
  const open = shell.classList.contains('sidebar-open');
  const expanded = mobile ? open : !shell.classList.contains('sidebar-collapsed');
  const menuToggle = document.querySelector('#menu-toggle');
  const sidebarToggle = document.querySelector('#sidebar-toggle');
  const label = expanded ? 'Collapse sidebar' : 'Expand sidebar';

  menuToggle.setAttribute('aria-expanded', String(expanded));
  menuToggle.setAttribute('aria-label', mobile ? 'Toggle navigation' : label);
  menuToggle.title = mobile ? 'Toggle navigation' : label;
  sidebarToggle.setAttribute('aria-expanded', String(expanded));
  sidebarToggle.setAttribute('aria-label', mobile ? 'Close navigation' : label);
  sidebarToggle.title = mobile ? 'Close navigation' : label;
  sidebarToggle.textContent = mobile ? '×' : expanded ? '‹' : '›';
  document.querySelector('#sidebar-backdrop').hidden = !mobile || !open;
}

function toggleSidebar() {
  if (sidebarQuery.matches) {
    shell.classList.toggle('sidebar-open');
  } else {
    const collapsed = !shell.classList.contains('sidebar-collapsed');
    shell.classList.toggle('sidebar-collapsed', collapsed);
    saveSidebarPreference(collapsed);
  }
  syncSidebarControls();
}

function closeMobileSidebar() {
  if (!sidebarQuery.matches) return;
  shell.classList.remove('sidebar-open');
  syncSidebarControls();
}

shell.classList.toggle('sidebar-collapsed', readSidebarPreference());
syncSidebarControls();
document.querySelector('#menu-toggle').onclick = toggleSidebar;
document.querySelector('#sidebar-toggle').onclick = toggleSidebar;
document.querySelector('#sidebar-backdrop').onclick = closeMobileSidebar;
document.addEventListener('navigation:change', closeMobileSidebar);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileSidebar();
});
sidebarQuery.addEventListener('change', () => {
  shell.classList.remove('sidebar-open');
  syncSidebarControls();
});

async function refreshHealthIndicator() {
  const indicator = document.querySelector('#health-indicator');
  setHealthState('checking', 'Checking health', 'Checking MCP server health.');
  try {
    const health = await request('/health');
    const healthy = health.mcpReachable === true
      || (health.mcpReachable === undefined && health.status === 'ok');
    setHealthState(
      healthy ? 'healthy' : 'unreachable',
      healthy ? 'Healthy' : 'Unreachable',
      healthy ? 'MCP server is reachable.' : 'The MCP server did not respond to its health check.',
    );
  } catch (error) {
    if (error.status === 404) {
      try {
        const status = await request('/status');
        const publicUrl = status.endpoints?.public;
        const detail = publicUrl
          ? `Public health URL: ${publicUrl.replace(/\/+$/, '')}/health`
          : 'No public health URL is configured.';
        setHealthState(
          'fallback',
          'Admin online',
          `Admin status is reachable, but detailed MCP health is unavailable. ${detail}`,
        );
        return;
      } catch {
        // Report unreachable below if even the status fallback fails.
      }
    }
    setHealthState('unreachable', 'Unreachable', 'The server health check failed.');
  }
  indicator.disabled = false;
}

function setHealthState(state, label, tooltip) {
  const indicator = document.querySelector('#health-indicator');
  indicator.classList.remove(
    'health-checking',
    'health-healthy',
    'health-unreachable',
    'health-fallback',
  );
  indicator.classList.add(`health-${state}`);
  indicator.disabled = state === 'checking';
  indicator.title = tooltip;
  indicator.setAttribute('aria-label', `${label}. ${tooltip}`);
  document.querySelector('#health-label').textContent = label;
}

document.querySelector('#health-indicator').onclick = refreshHealthIndicator;

function setTrustBadge(mode) {
  document.querySelector('#trust-badge').hidden = mode !== 'trust';
}

document.addEventListener('approval-mode:change', (event) => {
  setTrustBadge(event.detail.mode);
});

document.querySelector('#theme-toggle').onclick = () => {
  const current = localStorage.getItem('lc-theme') || 'auto';
  const next = current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark';
  localStorage.setItem('lc-theme', next);
  applyTheme(next);
  toast(`Theme: ${next}`);
};

function applyTheme(theme = localStorage.getItem('lc-theme') || 'auto') {
  document.documentElement.dataset.theme = theme === 'auto' ? '' : theme;
  document.querySelector('#theme-toggle').title = `Theme: ${theme}`;
}

applyTheme();
setRouteListener(renderRoute);
