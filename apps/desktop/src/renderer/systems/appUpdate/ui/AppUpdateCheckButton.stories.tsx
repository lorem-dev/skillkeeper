import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import { FormRow, FormSection } from '@/shared/ui';
import { makeAppUpdateOffer } from '../storyFixtures';
import { AppUpdateCheckButton } from './AppUpdateCheckButton';

const meta: Meta<typeof AppUpdateCheckButton> = {
  title: 'systems/appUpdate/AppUpdateCheckButton',
  component: AppUpdateCheckButton,
};
export default meta;
type Story = StoryObj<typeof AppUpdateCheckButton>;

/** The About dialog's manual "Check for updates" trigger, at rest. */
export const Default: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {});
    }, []);
    return <AppUpdateCheckButton />;
  },
};

/**
 * Settings' usage (`offerUpdateNow`), at rest: identical to the About
 * dialog's, since no offer is held yet.
 */
export const SettingsAtRest: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {});
    }, []);
    return <AppUpdateCheckButton offerUpdateNow />;
  },
};

/**
 * Settings' usage after a check found an installable update: "Update now"
 * appears next to "Check for updates", driving the existing "update
 * available" dialog rather than a second implementation of the flow.
 */
export const SettingsWithUpdateFound: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({ appUpdate: { offer: makeAppUpdateOffer(), downloading: false, percent: 0 } });
      });
    }, []);
    return <AppUpdateCheckButton offerUpdateNow />;
  },
};

/**
 * The row as Settings actually composes it, so the LAYOUT is reviewable and
 * not just the buttons. The cadence text is the row's description rather than
 * a section footer: without it the row is an empty expanse with a button
 * pinned to the right edge and the explanation floating loose underneath.
 *
 * Story-only wrapper; the real page supplies the same FormSection/FormRow.
 * Text is plain ASCII here, as stories do not use i18n.
 */
function SettingsRow({ children }: { readonly children: ReactNode }) {
  return (
    <div style={{ width: 640 }}>
      <FormSection title="Application updates">
        <FormRow description="SkillKeeper checks for a new version on startup and once a day.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sk-space-3)' }}>{children}</div>
        </FormRow>
      </FormSection>
    </div>
  );
}

/** The section at rest: description on the leading edge, one button trailing. */
export const SettingsRowAtRest: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {});
    }, []);
    return (
      <SettingsRow>
        <AppUpdateCheckButton offerUpdateNow />
      </SettingsRow>
    );
  },
};

/** The section once an update is found: both buttons share the trailing edge. */
export const SettingsRowWithUpdateFound: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: { offer: makeAppUpdateOffer(), downloading: false, percent: 0 },
        });
      });
    }, []);
    return (
      <SettingsRow>
        <AppUpdateCheckButton offerUpdateNow />
      </SettingsRow>
    );
  },
};
