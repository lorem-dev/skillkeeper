import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import { makeAppUpdateOffer } from '../storyFixtures';
import { UpdateReadyDialog } from './UpdateReadyDialog';

const meta: Meta<typeof UpdateReadyDialog> = {
  title: 'systems/appUpdate/UpdateReadyDialog',
  component: UpdateReadyDialog,
};
export default meta;
type Story = StoryObj<typeof UpdateReadyDialog>;

const OFFER = makeAppUpdateOffer();
// Matches the fixture offer's version, and points where a DOWNLOADED artifact
// actually lands (the app-data `update/` directory), not at /Applications --
// an earlier value said 0.7.0 under /Applications above a body reading 1.4.2,
// which is a state the app can never be in.
const PATH = '/Users/you/.config/skillkeeper/update/SkillKeeper_1.4.2_aarch64.dmg';

export const Default: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: { offer: OFFER, downloading: false, percent: 0 },
          appUpdateReadyOpen: true,
          appUpdateReadyPath: PATH,
        });
      });
    }, []);
    return <UpdateReadyDialog />;
  },
};

// The macOS manual-fallback branch (`appUpdateInstallFailed` plus a darwin
// host) was previously unreachable in Storybook because it read
// `bridgeClient.platform`, a real Tauri-bridge singleton that reads as `''`
// at story time (only `init()`, never called here, populates it) -- forcing
// it would have meant mutating that shared singleton, leaking into every
// other story reading `.platform` in the same session (e.g. WindowChrome's).
// `UpdateReadyDialog` now takes `platform` as a prop (defaulting to the
// singleton for real application use), so the story can supply it directly.
export const MacFallbackAfterFailedInstall: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: { offer: OFFER, downloading: false, percent: 0 },
          appUpdateReadyOpen: true,
          appUpdateReadyPath: PATH,
          appUpdateInstallFailed: true,
        });
      });
    }, []);
    return <UpdateReadyDialog platform="darwin" />;
  },
};

// The preserved artifact from a marker-based failure did not re-verify
// (corrupt, missing, or superseded by a newer offer since decided) --
// `appUpdateReadyCanInstall: false` swaps "Install now" for "Download
// again" so the button never looks like it will work when it cannot. The
// fallback command still shows on macOS: it names no downloaded file, so
// verification failing does not affect it.
export const UnverifiedArtifactOffersDownloadAgain: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: { offer: OFFER, downloading: false, percent: 0 },
          appUpdateReadyOpen: true,
          appUpdateReadyPath: PATH,
          appUpdateInstallFailed: true,
          appUpdateReadyCanInstall: false,
        });
      });
    }, []);
    return <UpdateReadyDialog platform="darwin" />;
  },
};
