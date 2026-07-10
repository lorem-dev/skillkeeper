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

// Content much taller than the viewport: the dialog cannot fit, so it flows
// to its full height and the SCRIM (not an inner body scroll) becomes the
// scroll container -- the whole modal block, title through actions, scrolls
// as one unit. The off-screen-going edge gets a DARK gradient scrim bar
// (content keeps full opacity and darkens into the dark surroundings, it is
// not faded to transparent). Scroll the story canvas to see the top bar
// appear once scrolled past the start, and the bottom bar disappear once
// scrolled to the end.
export const VeryTallContentScrollsWithDarkeningScrim: Story = {
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
              This dialog is much taller than the viewport. The scrim scrolls
              the whole block -- title, body, and actions together -- rather
              than growing off-screen or scrolling only an inner region.
            </p>
            {Array.from({ length: 24 }, (_, i) => (
              <p key={i}>
                Section {i + 1} of a long form. Keep scrolling to watch the
                top edge darken into a scrim bar and the bottom bar dim away
                near the end.
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
