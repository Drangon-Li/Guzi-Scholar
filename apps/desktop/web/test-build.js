(() => {
  'use strict';

  async function showTestBuild() {
    const desktop = window.myScholarDesktop;
    if (typeof desktop?.getStartupContext !== 'function') return;
    try {
      const context = await desktop.getStartupContext();
      const development = context?.ok && context.app?.developmentBuild;
      const build = development || (context?.ok && context.app?.localTestBuild);
      if (!build || document.getElementById('localTestBuildBadge')) return;
      const style = document.createElement('style');
      style.textContent = '#localTestBuildBadge{position:fixed;right:14px;bottom:12px;z-index:95;padding:5px 9px;border:1px solid rgba(126,91,35,.28);border-radius:7px;background:rgba(255,247,225,.94);color:#76551f;font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em;pointer-events:none;user-select:none}body .toast{bottom:calc(48px + env(safe-area-inset-bottom) + var(--background-tasks-offset,0px))}';
      const badge = document.createElement('div');
      badge.id = 'localTestBuildBadge';
      badge.setAttribute('role', 'note');
      badge.textContent = `${development ? '开发版' : '测试版'} · ${build}`;
      document.head.appendChild(style);
      document.body.appendChild(badge);
    } catch (error) {
      console.warn('无法读取本地测试版本标识。', error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showTestBuild, { once: true });
  else void showTestBuild();
})();
