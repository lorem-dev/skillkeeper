import type { Preview } from '@storybook/react';
import '@/styles/index.scss';

// Canvas backdrops, selectable from the toolbar. A colorful/patterned backdrop
// behind a glass element shows how its blur/refraction reacts to surroundings.
// All are pure CSS (no external assets) so they work offline and under the CSP.
// Refraction only shows over backdrops with detail/contrast, so most of these
// are high-frequency patterns (hard color stops, dots, stripes), plus one smooth
// gradient for comparison.
const BACKDROPS: Record<string, string> = {
  none: 'var(--sk-color-bg)',
  gradient: 'linear-gradient(135deg, #0088ff, #ff2d55 50%, #ffcc00)',
  // Hard-stop conic wedges -> sharp edges the displacement clearly bends.
  conic:
    'conic-gradient(#0088ff 0 60deg, #ff2d55 60deg 120deg, #ffcc00 120deg 180deg,' +
    ' #34c759 180deg 240deg, #cb30e0 240deg 300deg, #00c8b3 300deg 360deg)',
  dots: 'radial-gradient(#0088ff 30%, transparent 31%) 0 0 / 22px 22px, #0d0d0d',
  stripes: 'repeating-linear-gradient(45deg, #1c1c1e 0 14px, #f2f2f7 14px 28px)',
};

const preview: Preview = {
  parameters: {
    layout: 'centered',
  },
  globalTypes: {
    theme: {
      description: 'Design-system theme',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
    backdrop: {
      description: 'Canvas backdrop (for previewing glass refraction)',
      defaultValue: 'none',
      toolbar: {
        title: 'Backdrop',
        icon: 'photo',
        items: [
          { value: 'none', title: 'None' },
          { value: 'gradient', title: 'Gradient' },
          { value: 'conic', title: 'Conic' },
          { value: 'dots', title: 'Dots' },
          { value: 'stripes', title: 'Stripes' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals['theme'] === 'dark' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', theme);
      // Paint the whole preview canvas; glass elements refract this backdrop.
      // Stories that bake their own backdrops set `parameters.lockBackdrop` to
      // opt out of the toolbar selection.
      const locked = context.parameters['lockBackdrop'] === true;
      const backdrop = locked ? 'none' : String(context.globals['backdrop'] ?? 'none');
      document.body.style.background = BACKDROPS[backdrop] ?? 'var(--sk-color-bg)';
      document.body.style.color = 'var(--sk-color-label)';
      return (
        <div style={{ padding: '2rem' }}>
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
