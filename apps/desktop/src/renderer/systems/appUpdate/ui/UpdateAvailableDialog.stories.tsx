import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import type { AppUpdateOffer } from '@/services/bridge';
import { makeAppUpdateOffer } from '../storyFixtures';
import { UpdateAvailableDialog } from './UpdateAvailableDialog';

const meta: Meta<typeof UpdateAvailableDialog> = {
  title: 'systems/appUpdate/UpdateAvailableDialog',
  component: UpdateAvailableDialog,
};
export default meta;
type Story = StoryObj<typeof UpdateAvailableDialog>;

function seedOffer(offer: AppUpdateOffer): void {
  seedStore(() => {
    useSkillkeeperStore.setState({
      appUpdate: { offer, downloading: false, percent: 0 },
      appUpdateAvailableOpen: true,
    });
  });
}

const SHORT_NOTES = '- Fixed a startup crash on Windows.\n- Improved sync performance for large repositories.';

/**
 * Generates enough release-note lines that the notes `<pre>` actually scrolls
 * (it caps at `max-height: 50vh` in UpdateAvailableDialog.scss), plus one very
 * long unbroken line so `overflow-wrap: anywhere` visibly wraps it instead of
 * stretching the dialog sideways.
 */
function makeLongNotes(): string {
  const lines = Array.from(
    { length: 40 },
    (_unused, i) => `- Fixed issue number ${i + 1} affecting the sync pipeline.`,
  );
  lines.push(`- See commit ${'abcdef1234567890'.repeat(20)} for the full change.`);
  return lines.join('\n');
}

export const ShortNotes: Story = {
  render: () => {
    useEffect(() => {
      seedOffer(makeAppUpdateOffer({ notes: SHORT_NOTES }));
    }, []);
    return <UpdateAvailableDialog />;
  },
};

export const LongNotes: Story = {
  render: () => {
    useEffect(() => {
      seedOffer(makeAppUpdateOffer({ notes: makeLongNotes() }));
    }, []);
    return <UpdateAvailableDialog />;
  },
};

/** History was truncated: the footer line pointing at the full comparison is showing. */
export const TruncatedHistory: Story = {
  render: () => {
    useEffect(() => {
      seedOffer(makeAppUpdateOffer({ notes: SHORT_NOTES, truncatedHistory: true }));
    }, []);
    return <UpdateAvailableDialog />;
  },
};
