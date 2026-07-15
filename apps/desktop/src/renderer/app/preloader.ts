/**
 * Controls the hardcoded startup preloader defined in index.html (a themed
 * full-window overlay with a spinner, kept text-free so it needs no i18n).
 *
 * Once the app has loaded its initial data, `dismissPreloader` reveals the app
 * by fading the overlay out over 300ms (`animated: true`) or removing it
 * instantly (`animated: false`, i.e. the `animations: 'off'` preference).
 */
const FADE_MS = 300;

export function dismissPreloader(animated: boolean): void {
  const el = document.getElementById('sk-preloader');
  if (el === null || el.dataset['dismissing'] === '1') return;
  el.dataset['dismissing'] = '1';

  if (!animated) {
    el.remove();
    return;
  }

  const remove = (): void => el.remove();
  el.addEventListener('transitionend', remove, { once: true });
  // Fallback in case `transitionend` never fires (e.g. window not visible).
  window.setTimeout(remove, FADE_MS + 100);

  el.style.transition = `opacity ${FADE_MS}ms ease`;
  // Next frame, so the transition has a starting value to animate from.
  requestAnimationFrame(() => {
    el.style.opacity = '0';
  });
}
