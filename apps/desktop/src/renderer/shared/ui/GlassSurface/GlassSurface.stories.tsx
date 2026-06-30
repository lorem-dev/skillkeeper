import type { Meta, StoryObj } from '@storybook/react';
import { GlassSurface } from './GlassSurface';

const meta = {
  title: 'shared/ui/GlassSurface',
  component: GlassSurface,
  // These stories bake in their own backdrops, so ignore the Backdrop toolbar.
  parameters: { lockBackdrop: true },
} satisfies Meta<typeof GlassSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

// Switch the "Backdrop" toolbar to see how the surface reacts to its
// surroundings. Each story also bakes in its own backdrop. The rim refraction is
// most visible over detailed/high-contrast content.
const BACKDROPS = {
  gradient: 'linear-gradient(135deg, #0088ff, #ff2d55 50%, #ffcc00)',
  conic:
    'conic-gradient(#0088ff 0 60deg, #ff2d55 60deg 120deg, #ffcc00 120deg 180deg,' +
    ' #34c759 180deg 240deg, #cb30e0 240deg 300deg, #00c8b3 300deg 360deg)',
  dots: 'radial-gradient(#0088ff 30%, transparent 31%) 0 0 / 22px 22px, #0d0d0d',
  stripes: 'repeating-linear-gradient(45deg, #1c1c1e 0 14px, #f2f2f7 14px 28px)',
};

function show(background: string, props: Record<string, number>) {
  return (
    <div
      style={{
        width: 360,
        height: 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 16,
        background,
      }}
    >
      <GlassSurface {...props}>
        <div style={{ padding: '20px 28px', fontWeight: 600 }}>Glass</div>
      </GlassSurface>
    </div>
  );
}

export const OnConic: Story = {
  render: () => show(BACKDROPS.conic, { strength: 45, depth: 8, chromaticAberration: 2 }),
};
export const OnDots: Story = {
  render: () => show(BACKDROPS.dots, { strength: 40, depth: 8, chromaticAberration: 2 }),
};
export const OnStripes: Story = {
  render: () => show(BACKDROPS.stripes, { strength: 45, depth: 8, chromaticAberration: 2 }),
};
export const OnGradient: Story = {
  render: () => show(BACKDROPS.gradient, { strength: 36, depth: 8, chromaticAberration: 1 }),
};
