(() => {
  'use strict';

  const root = document.documentElement;
  const motionToggle = document.querySelector('#motion-toggle');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const storageKey = 'guzi-scholar-book-motion';
  const video = document.querySelector('#operation-video');
  const replay = document.querySelector('#replay-video');
  let userMotionOff = false;
  let videoVisible = false;
  let videoFullyVisible = false;
  let autoplayAttempted = false;
  let autoplayRunning = false;

  try { userMotionOff = localStorage.getItem(storageKey) === 'off'; } catch {}

  const motionEnabled = () => !userMotionOff && !reducedMotion.matches;

  const background = document.querySelector('main');
  const backgroundScenes = [...document.querySelectorAll('.hero, .feature-band, .download-section')];
  const readingFinale = document.querySelector('#summary');
  let backgroundFrame = 0;

  function renderBackground() {
    backgroundFrame = 0;
    const viewportHeight = window.innerHeight;
    const scrollRange = document.documentElement.scrollHeight - viewportHeight;
    const textureProgress = scrollRange > 0 ? Math.max(0, Math.min(1, window.scrollY / scrollRange)) : 0;
    const finaleRect = readingFinale.getBoundingClientRect();
    const lightEnd = Math.min(scrollRange, Math.max(viewportHeight, finaleRect.top + window.scrollY - viewportHeight * .45));
    const lightPosition = lightEnd > 0 ? Math.max(0, Math.min(1, window.scrollY / lightEnd)) : 0;
    const lightProgress = lightPosition * (2 - lightPosition);
    const dockStart = Math.max(0, finaleRect.top + window.scrollY - viewportHeight * .8);
    const dockEnd = Math.min(scrollRange, finaleRect.top + window.scrollY - viewportHeight * .3);
    const lampDocked = Math.max(0, Math.min(1, (window.scrollY - dockStart) / Math.max(1, dockEnd - dockStart)));
    // Read each section before writing styles to avoid layout work between updates.
    const progress = backgroundScenes.map((scene) => {
      const rect = scene.getBoundingClientRect();
      const position = scene.id === 'cover'
        ? window.scrollY / viewportHeight
        : (viewportHeight / 2 - rect.top - rect.height / 2) / viewportHeight;
      return Math.max(-1, Math.min(1, position));
    });
    background.style.setProperty('--texture-progress', textureProgress.toFixed(4));
    root.style.setProperty('--lamp-progress', lightProgress.toFixed(4));
    root.style.setProperty('--lamp-docked', lampDocked.toFixed(4));
    backgroundScenes.forEach((scene, index) => scene.style.setProperty('--scene-progress', progress[index].toFixed(4)));
  }

  function queueBackground() {
    if (backgroundFrame || !motionEnabled() || document.hidden) return;
    backgroundFrame = requestAnimationFrame(renderBackground);
  }

  function syncBackground() {
    cancelAnimationFrame(backgroundFrame);
    backgroundFrame = 0;
    queueBackground();
  }

  window.addEventListener('scroll', queueBackground, { passive: true });
  window.addEventListener('resize', queueBackground);
  new ResizeObserver(queueBackground).observe(background);

  function syncVideo() {
    if (!video) return;
    if (document.hidden || !videoVisible || (autoplayRunning && !motionEnabled())) {
      video.pause();
      autoplayRunning = false;
      return;
    }
    if (!videoFullyVisible || !motionEnabled() || autoplayAttempted) return;
    autoplayAttempted = true;
    autoplayRunning = true;
    video.muted = true;
    video.play()?.catch(() => { autoplayRunning = false; });
  }

  function syncMotion() {
    const enabled = motionEnabled();
    root.dataset.motion = enabled ? 'on' : 'off';
    if (motionToggle) {
      motionToggle.hidden = false;
      motionToggle.disabled = reducedMotion.matches;
      motionToggle.setAttribute('aria-pressed', String(enabled));
      motionToggle.textContent = `动效：${enabled ? '开' : '关'}`;
      motionToggle.title = reducedMotion.matches ? '已跟随系统减少动态效果设置' : '切换动态效果';
    }
    syncBackground();
    syncVideo();
  }

  motionToggle?.addEventListener('click', () => {
    userMotionOff = !userMotionOff;
    try { localStorage.setItem(storageKey, userMotionOff ? 'off' : 'on'); } catch {}
    syncMotion();
  });
  reducedMotion.addEventListener('change', syncMotion);
  document.addEventListener('visibilitychange', () => {
    syncBackground();
    syncVideo();
  });

  if (video) {
    video.addEventListener('play', () => { autoplayAttempted = true; });
    video.addEventListener('pause', () => { autoplayRunning = false; });
    video.addEventListener('ended', () => { autoplayRunning = false; });
    if (replay) {
      replay.hidden = false;
      replay.addEventListener('click', () => {
        autoplayAttempted = true;
        autoplayRunning = false;
        video.currentTime = 0;
        video.play()?.catch(() => {});
      });
    }
    if ('IntersectionObserver' in window) {
      const videoObserver = new IntersectionObserver(([entry]) => {
        videoVisible = entry.isIntersecting && entry.intersectionRatio > 0;
        videoFullyVisible = entry.isIntersecting && entry.intersectionRatio >= 1;
        syncVideo();
      }, { threshold: [0, 1] });
      videoObserver.observe(video);
    }
  }

  const viewer = document.querySelector('dialog.image-viewer');
  const viewerImage = viewer?.querySelector('.viewer-image');
  const viewerTitle = viewer?.querySelector('#viewer-title');
  let previewLink = null;

  if (viewer && viewerImage && typeof viewer.showModal === 'function') {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-preview]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      event.preventDefault();
      previewLink = link;
      const title = link.dataset.imageAlt || link.querySelector('img')?.alt || '图片预览';
      viewerImage.src = link.href;
      viewerImage.alt = title;
      if (viewerTitle) viewerTitle.textContent = title;
      viewer.showModal();
      const canvas = viewer.querySelector('.viewer-canvas');
      if (canvas) {
        canvas.scrollLeft = 0;
        canvas.scrollTop = 0;
      }
    });
    viewer.addEventListener('click', (event) => {
      if (event.target !== viewer) return;
      const rect = viewer.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) viewer.close();
    });
    viewer.addEventListener('close', () => {
      previewLink?.focus({ preventScroll: true });
      previewLink = null;
    });
  }

  const legacyHashes = { reading: 'format', 'in-context': 'conversation', 'book-track': 'cover' };
  function redirectLegacyHash() {
    const id = legacyHashes[location.hash.slice(1)];
    const target = id && document.getElementById(id);
    if (!target) return;
    history.replaceState(history.state, '', `#${id}`);
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  window.addEventListener('hashchange', redirectLegacyHash);
  syncMotion();
  redirectLegacyHash();
})();
