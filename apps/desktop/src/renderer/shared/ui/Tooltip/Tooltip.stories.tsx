import type { Meta, StoryObj } from '@storybook/react';
import type { ReactElement, ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import { Button } from '../Button';

const meta = {
  title: 'shared/ui/Tooltip',
  component: Tooltip,
  // Required props satisfied here; each story's render provides the real content.
  args: { content: '', children: null },
} satisfies Meta<typeof Tooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

// Center the trigger so a fixed placement has room on every side. Hover the
// button to reveal the bubble.
function stage(node: ReactNode): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 180 }}>
      {node}
    </div>
  );
}

export const Top: Story = {
  render: () =>
    stage(
      <Tooltip content="Top tooltip" placement="top">
        <Button>Top</Button>
      </Tooltip>,
    ),
};

export const Bottom: Story = {
  render: () =>
    stage(
      <Tooltip content="Bottom tooltip" placement="bottom">
        <Button>Bottom</Button>
      </Tooltip>,
    ),
};

export const Left: Story = {
  render: () =>
    stage(
      <Tooltip content="Left tooltip" placement="left">
        <Button>Left</Button>
      </Tooltip>,
    ),
};

export const Right: Story = {
  render: () =>
    stage(
      <Tooltip content="Right tooltip" placement="right">
        <Button>Right</Button>
      </Tooltip>,
    ),
};

// Auto pinned to the top-left corner: no room above or left, so it flips to a
// side that fits and shifts to stay inside the window.
export const Auto: Story = {
  render: () => (
    <div style={{ position: 'relative', minHeight: 180 }}>
      <div style={{ position: 'absolute', top: 0, left: 0 }}>
        <Tooltip content="Auto placement stays in view" placement="auto">
          <Button>Auto (corner)</Button>
        </Tooltip>
      </div>
    </div>
  ),
};
