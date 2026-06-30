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
