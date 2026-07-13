import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Modal } from './Modal';
import { Button } from '../Button';

const meta = {
  title: 'shared/ui/Modal',
  component: Modal,
  // open/onClose are required props, so CSF needs them satisfied here; the
  // stateful render below actually drives the modal and overrides these.
  args: { open: false, onClose: () => {} },
} satisfies Meta<typeof Modal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open dialog
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} title="Install hook">
          Installing a hook edits the agent configuration. Continue?
        </Modal>
      </>
    );
  },
};

// Content well under the viewport height: the dialog centers in the scrim
// with no scrolling and no edge scrim bar in either direction.
export const ShortContentStaysCentered: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open short dialog
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} title="Short content">
          This dialog is short enough to stay centered in the scrim -- no
          scrolling, no edge scrim bar.
        </Modal>
      </>
    );
  },
};

// Content taller than the window: the dialog flows to its full content height
// and the whole block scrolls within the window (the scroll is on the window,
// not the dialog), keeping its margin on every side. A fade block appears at
// whichever edge still has hidden content -- the leaving content dissolves into
// the dark surroundings. Scroll to see the top block appear once past the start
// and the bottom block disappear at the end.
export const VeryTallContentScrollsWithEdgeFades: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open very tall dialog
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} title="Very tall content">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p>
              This dialog is much taller than the window, so the whole block
              scrolls within the window (title through actions) as one unit,
              keeping a margin on every side.
            </p>
            {Array.from({ length: 24 }, (_, i) => (
              <p key={i}>
                Section {i + 1} of a long form. Keep scrolling to watch the top
                fade block appear as content leaves upward and the bottom block
                fade away near the end.
              </p>
            ))}
            <Button variant="primary" onClick={() => setOpen(false)}>
              Save (reachable by scrolling to the end)
            </Button>
          </div>
        </Modal>
      </>
    );
  },
};
