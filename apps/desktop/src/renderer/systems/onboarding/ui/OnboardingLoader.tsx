import './OnboardingLoader.scss';

/**
 * Full-screen onboarding preloader: a React port of the hardcoded startup
 * spinner in `index.html` (12 fading spokes, stepped spin), on the same scene
 * background as the welcome screen. Shown while the welcome screen waits for
 * its data; the content then fades in. Text-free and aria-hidden, matching the
 * HTML preloader.
 */
const SPOKES: readonly { readonly rotate: number; readonly opacity: number }[] = [
  { rotate: 0, opacity: 1 },
  { rotate: 30, opacity: 0.92 },
  { rotate: 60, opacity: 0.85 },
  { rotate: 90, opacity: 0.77 },
  { rotate: 120, opacity: 0.69 },
  { rotate: 150, opacity: 0.61 },
  { rotate: 180, opacity: 0.54 },
  { rotate: 210, opacity: 0.46 },
  { rotate: 240, opacity: 0.38 },
  { rotate: 270, opacity: 0.31 },
  { rotate: 300, opacity: 0.23 },
  { rotate: 330, opacity: 0.15 },
];

export function OnboardingLoader() {
  return (
    <div className="sk-onboarding-loader" aria-hidden="true">
      <svg className="sk-onboarding-loader__spinner" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        {SPOKES.map((s) => (
          <rect
            key={s.rotate}
            className="sk-onboarding-loader__spoke"
            x="45.5"
            y="6"
            width="9"
            height="24"
            rx="4.5"
            transform={`rotate(${s.rotate} 50 50)`}
            opacity={s.opacity}
          />
        ))}
      </svg>
    </div>
  );
}
