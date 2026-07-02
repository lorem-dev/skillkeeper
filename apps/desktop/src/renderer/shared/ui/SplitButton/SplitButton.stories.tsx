import type { Meta, StoryObj } from '@storybook/react';
import { SplitButton } from './SplitButton';
import { Icon } from '../Icon';

const meta = {
  title: 'shared/ui/SplitButton',
  component: SplitButton,
  args: {
    tooltip: 'Open the config file in an editor',
    menuLabel: 'Choose an editor',
    onPrimary: () => {},
  },
} satisfies Meta<typeof SplitButton>;

export default meta;

type Story = StoryObj<typeof meta>;

// A 1x1 transparent PNG stands in for a real app icon data URL in stories.
const dot =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const editImg = <Icon name="edit" />;

export const WithSystemIcons: Story = {
  args: {
    icon: <img src={dot} width={20} height={20} alt="" />,
    items: [
      { id: 'vscode', label: 'Visual Studio Code', icon: <img src={dot} width={20} height={20} alt="" />, onSelect: () => {} },
      { id: 'zed', label: 'Zed', icon: <img src={dot} width={20} height={20} alt="" />, onSelect: () => {} },
      { id: 'default', label: 'Open in default app', icon: <img src={dot} width={20} height={20} alt="" />, onSelect: () => {} },
    ],
  },
};

export const LinuxNoIcons: Story = {
  args: {
    icon: editImg,
    items: [
      { id: 'vscode', label: 'Visual Studio Code', onSelect: () => {} },
      { id: 'zed', label: 'Zed', onSelect: () => {} },
      { id: 'default', label: 'Open in default app', onSelect: () => {} },
    ],
  },
};
