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
let serverStatus;

async function renderRoute(route) {
  if (route !== 'activity') closeActivityStream();
  view.innerHTML = '<div class="skeleton skeleton-title"></div><div class="skeleton skeleton-card"></div>';

  try {
    serverStatus = await request('/status');
    setConnectionState(true);
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
document.querySelector('#menu-toggle').onclick = () => {
  document.querySelector('.sidebar').classList.toggle('open');
};

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
