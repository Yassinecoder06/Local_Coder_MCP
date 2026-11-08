const pageNames = {
  connect: 'Connect',
  skills: 'Skills',
  commands: 'Commands',
  tools: 'Tools',
  activity: 'Activity',
  settings: 'Settings',
};

export function currentRoute() {
  const route = location.hash.slice(1) || 'connect';
  return Object.hasOwn(pageNames, route) ? route : 'connect';
}

export function pageTitle(route) {
  return pageNames[route] || pageNames.connect;
}

export function navigateTo(route) {
  location.hash = `#${route}`;
}

export function setRouteListener(onRoute) {
  const updateRoute = () => {
    const route = currentRoute();
    document.querySelector('#breadcrumb').textContent = pageTitle(route);
    document.querySelectorAll('[data-route]').forEach((link) => {
      link.classList.toggle('active', link.dataset.route === route);
    });
    document.querySelector('.sidebar').classList.remove('open');
    onRoute(route);
  };

  window.addEventListener('hashchange', updateRoute);
  updateRoute();
  return () => window.removeEventListener('hashchange', updateRoute);
}
