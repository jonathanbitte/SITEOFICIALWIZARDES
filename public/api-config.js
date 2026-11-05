// A API fica no Render, enquanto as páginas do site ficam na UOL Host.
(() => {
  const base = 'https://api.wizardes.com.br';
  window.WIZARD_API_BASE = base;
  window.apiUrl = (path) => `${base}${path.startsWith('/') ? path : `/${path}`}`;
  window.apiFetch = (path, options = {}) => fetch(window.apiUrl(path), {
    ...options,
    credentials: 'include',
  });
})();
