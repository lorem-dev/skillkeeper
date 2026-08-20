import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import { makeAppUpdateOffer } from '../storyFixtures';
import { UpdateBadge } from './UpdateBadge';

const meta: Meta<typeof UpdateBadge> = {
  title: 'systems/appUpdate/UpdateBadge',
  component: UpdateBadge,
};
export default meta;
type Story = StoryObj<typeof UpdateBadge>;

/**
 * A stand-in for the real status bar, so the badge is seen in the layout it
 * actually lives in rather than in a bare box.
 *
 * Story-only: these inline styles mirror `.sk-statusbar` and
 * `.sk-statusbar__lead` from StatusBar.scss (flex row, trailing-aligned, the
 * leading pair carrying the auto margin and `min-width: 0`). The tinted
 * background and border exist only to make the container's edges visible here,
 * and are deliberately NOT part of the component -- the real bar gets its own
 * glass tint from the stylesheet.
 *
 * The version text and the three trailing squares are placeholders standing in
 * for the real bar's contents, present so it is obvious at a glance that a long
 * badge label neither grows the bar nor pushes the trailing buttons out.
 */
function Bar({ width, children }: { readonly width: number; readonly children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 'var(--sk-space-1)',
        width,
        height: 'var(--sk-control-height)',
        padding: '0 var(--sk-space-3)',
        background: 'var(--sk-color-bg-secondary)',
        border: '1px solid var(--sk-color-separator)',
        borderRadius: 'var(--sk-radius-xs)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sk-space-2)',
          minWidth: 0,
          overflow: 'hidden',
          marginRight: 'auto',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--sk-color-label-3)' }}>0.5.0</span>
        {children}
      </div>
      {['check', 'terminal', 'bell'].map((name) => (
        <span
          key={name}
          aria-hidden="true"
          style={{
            width: 26,
            height: 26,
            flex: 'none',
            borderRadius: 'var(--sk-radius-xs)',
            background: 'var(--sk-color-fill-3)',
          }}
        />
      ))}
    </div>
  );
}

/** Idle: the offered version, clickable to reopen the "update available" dialog. */
export const Available: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: { offer: makeAppUpdateOffer(), downloading: false, percent: 0 },
        });
      });
    }, []);
    return (
      <Bar width={560}>
        <UpdateBadge />
      </Bar>
    );
  },
};

/** Mid-download: the badge shows a percentage instead of the version, and is disabled. */
export const Downloading: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: { offer: makeAppUpdateOffer(), downloading: true, percent: 47 },
        });
      });
    }, []);
    return (
      <Bar width={560}>
        <UpdateBadge />
      </Bar>
    );
  },
};

/**
 * The common case, stated explicitly because it is the one that matters: at a
 * normal window width the label renders in FULL and is not truncated at all.
 * Compare with `LongVersion` below.
 */
export const FitsWithoutTruncating: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: {
            offer: makeAppUpdateOffer({ version: '0.6.0' }),
            downloading: false,
            percent: 0,
          },
        });
      });
    }, []);
    return (
      <Bar width={720}>
        <UpdateBadge />
      </Bar>
    );
  },
};

/**
 * An implausibly long version in a genuinely narrow bar: the only situation in
 * which the badge truncates at all. The label ellipsizes on the TRAILING edge,
 * the bar keeps its height, and the three trailing squares stay 26px and fully
 * visible because they carry `flex: none`.
 *
 * Truncation is now driven purely by the bar running out of room. It used to be
 * driven by a `max-width: 40%` on the badge, which resolved against a wrapper
 * the badge itself sized -- so it collapsed the label at every width, which is
 * what this story was unintentionally demonstrating.
 */
export const LongVersion: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.setState({
          appUpdate: {
            offer: makeAppUpdateOffer({ version: '10.20.30-alpha.build-metadata-2026-08-19-long-tag' }),
            downloading: false,
            percent: 0,
          },
        });
      });
    }, []);
    return (
      <Bar width={300}>
        <UpdateBadge />
      </Bar>
    );
  },
};
