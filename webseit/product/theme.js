(() => {
  const storageKey = 'guzi-scholar-appearance';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let select;
  let appearance = 'system';

  const normalize = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';

  try {
    appearance = normalize(window.localStorage.getItem(storageKey));
  } catch {}

  function applyTheme() {
    const theme = appearance === 'system' ? (systemTheme.matches ? 'dark' : 'light') : appearance;
    root.dataset.theme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === 'dark' ? '#181c19' : '#f3efe5';
    if (select) select.value = appearance;
  }

  function connectSelect() {
    select = document.getElementById('theme-select');
    if (!select) return;
    select.value = appearance;
    select.hidden = false;
    select.addEventListener('change', () => {
      appearance = normalize(select.value);
      try {
        window.localStorage.setItem(storageKey, appearance);
      } catch {}
      applyTheme();
    });
    applyTheme();
  }

  applyTheme();
  systemTheme.addEventListener('change', () => {
    if (appearance === 'system') applyTheme();
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    appearance = normalize(event.newValue);
    applyTheme();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connectSelect, { once: true });
  } else {
    connectSelect();
  }
})();
