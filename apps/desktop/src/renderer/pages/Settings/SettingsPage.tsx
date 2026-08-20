import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { useAnimationsEnabled, useAnimationScale, SK_DURATION, SK_EASE } from '@/shared/lib';
import { useOnboardingActions } from '@/systems/onboarding';
import { LanguageThemeFields } from '@/systems/settings';
import { AppUpdateCheckButton } from '@/systems/appUpdate';
import { SshKeyField } from '@/features/sshKey';
import type { UpdatesConfig } from '@/services/bridge';
import {
  Page,
  Toolbar,
  FormSection,
  FormRow,
  SegmentedControl,
  TextField,
  IntervalStepper,
  Button,
  Tooltip,
  Icon,
} from '@/shared/ui';
import { OpenConfigButton } from './OpenConfigButton';
import './SettingsPage.scss';

interface GitRowProps {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly onCommit: (value: string) => void;
}

function GitRow({ value, label, description, onCommit }: GitRowProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <FormRow label={label} description={description}>
      <TextField
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== value) onCommit(next);
        }}
      />
    </FormRow>
  );
}

export function SettingsPage() {
  const config = useSkillkeeperStore((s) => s.config);
  const updateConfig = useSkillkeeperStore((s) => s.updateConfig);
  const openAbout = useSkillkeeperStore((s) => s.openAbout);
  const settingsAppUpdatesNav = useSkillkeeperStore((s) => s.settingsAppUpdatesNav);
  const clearAppUpdatesSettingsFocus = useSkillkeeperStore((s) => s.clearAppUpdatesSettingsFocus);
  const animate = useAnimationsEnabled();
  const scale = useAnimationScale();
  const t = useTranslator();
  const { start } = useOnboardingActions();
  const appUpdatesSectionRef = useRef<HTMLDivElement>(null);

  // The macOS Help menu's "Check for Updates" item bumps this nonce (via
  // `focusAppUpdatesSettings`); App switches the active view to Settings for
  // it, and this scrolls the section into view -- mirroring how `repoFocus`
  // scrolls its target card (RepositoriesPage). Runs on mount too, so landing
  // here from the menu (a fresh mount) still scrolls once the nonce is
  // already set.
  useEffect(() => {
    if (settingsAppUpdatesNav === 0) return;
    appUpdatesSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // Consume the request. The nonce would otherwise only ever grow, and this
    // page remounts on every navigation, so an ordinary sidebar visit later
    // would scroll again unasked.
    clearAppUpdatesSettingsFocus();
  }, [settingsAppUpdatesNav, clearAppUpdatesSettingsFocus]);

  if (config === null) return null;

  const animationOptions = [
    { value: 'fast', label: t('settings.animations.fast') },
    { value: 'normal', label: t('settings.animations.normal') },
    { value: 'off', label: t('settings.animations.off') },
  ];

  return (
    <Page
      title={t('nav.settings')}
      toolbar={
        <Toolbar
          title={t('nav.settings')}
          trailing={
            <>
              <OpenConfigButton />
              <Tooltip content={t('menu.about')}>
                <Button
                  variant="secondary"
                  glass
                  className="sk-about-btn"
                  aria-label={t('menu.about')}
                  onClick={openAbout}
                >
                  <Icon name="info" />
                </Button>
              </Tooltip>
            </>
          }
        />
      }
    >
      <motion.div
        className="sk-settings"
        initial={animate ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: SK_DURATION.medium * scale, ease: SK_EASE }}
      >
        <FormSection title={t('settings.section.general')}>
          <LanguageThemeFields languageClassName="sk-settings-language" />
          <FormRow label={t('settings.animations')} description={t('settings.animationsHint')}>
            <SegmentedControl
              label={t('settings.animations')}
              options={animationOptions}
              value={config.general.animations}
              onChange={(v) =>
                void updateConfig({ general: { animations: v as 'fast' | 'normal' | 'off' } })
              }
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.repositories')}>
          <GitRow
            value={config.repositories.gitPath}
            label={t('settings.git')}
            description={t('settings.gitDescription')}
            onCommit={(gitPath) => void updateConfig({ repositories: { gitPath } })}
          />
          <SshKeyField />
          <FormRow label={t('settings.updates.mode')}>
            <SegmentedControl
              label={t('settings.updates.mode')}
              options={[
                { value: 'manual', label: t('settings.updates.mode.manual') },
                { value: 'on-startup', label: t('settings.updates.mode.onStartup') },
                { value: 'scheduled', label: t('settings.updates.mode.scheduled') },
              ]}
              value={config.updates.mode}
              onChange={(v) => void updateConfig({ updates: { mode: v as UpdatesConfig['mode'] } })}
            />
          </FormRow>
          <FormRow label={t('settings.updates.interval')} disabled={config.updates.mode !== 'scheduled'}>
            <IntervalStepper
              minutes={config.updates.intervalMinutes}
              onChange={(intervalMinutes) => void updateConfig({ updates: { intervalMinutes } })}
              // The interval only applies to scheduled checks.
              disabled={config.updates.mode !== 'scheduled'}
              label={t('settings.updates.interval')}
              minutesUnitLabel={t('settings.interval.minutesUnit')}
              hoursUnitLabel={t('settings.interval.hoursUnit')}
              decreaseLabel={t('common.decrease')}
              increaseLabel={t('common.increase')}
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.projects')}>
          <FormRow label={t('settings.projects.checkInterval')}>
            <IntervalStepper
              minutes={config.projects.checkIntervalMinutes}
              onChange={(checkIntervalMinutes) => void updateConfig({ projects: { checkIntervalMinutes } })}
              label={t('settings.projects.checkInterval')}
              minutesUnitLabel={t('settings.interval.minutesUnit')}
              hoursUnitLabel={t('settings.interval.hoursUnit')}
              decreaseLabel={t('common.decrease')}
              increaseLabel={t('common.increase')}
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.onboarding')}>
          <FormRow description={t('settings.onboarding.restartHint')}>
            <Button variant="secondary" onClick={start}>
              {t('settings.onboarding.restart.button')}
            </Button>
          </FormRow>
        </FormSection>

        <div ref={appUpdatesSectionRef} data-settings-section="app-updates">
          <FormSection title={t('settings.section.appUpdates')}>
            {/* The cadence belongs on the row, not in a section footer: the row
                would otherwise be an empty expanse with a button pinned to its
                right edge, and the explanation would float loose underneath
                it. This is the shape the Tutorial section above already uses. */}
            <FormRow description={t('settings.appUpdates.hint')}>
              <div className="sk-settings-app-update-actions">
                <AppUpdateCheckButton offerUpdateNow />
              </div>
            </FormRow>
          </FormSection>
        </div>
      </motion.div>
    </Page>
  );
}
