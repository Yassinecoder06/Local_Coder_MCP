export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function toast(message, isError = false) {
  const element = document.createElement('div');
  element.className = `toast${isError ? ' toast-error' : ''}`;
  element.textContent = message;
  document.querySelector('#toast-region').append(element);
  setTimeout(() => element.remove(), 3200);
}

export async function copyText(value, successMessage = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    toast('Clipboard unavailable', true);
  }
}

export function bindCopyButtons(root = document) {
  root.querySelectorAll('[data-copy]').forEach((button) => {
    button.onclick = () => copyText(button.dataset.copy, button.dataset.copyMessage);
  });
}

export function pageHeader(kicker, title, subtitle, action = '') {
  return `<div class="page-heading">
    <div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p class="subheading">${subtitle}</p></div>
    ${action}
  </div>`;
}

export function duration(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) return `${Math.floor(value)}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

export function timeAgo(timestamp) {
  if (!timestamp) return '—';
  const seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function sourceBadge(source) {
  const safeSource = escapeHtml(source || 'unknown');
  return `<span class="badge source-${safeSource}">${safeSource}</span>`;
}

export function confirmAction(message) {
  return window.confirm(message);
}
