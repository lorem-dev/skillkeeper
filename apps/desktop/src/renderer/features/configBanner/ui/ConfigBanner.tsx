/**
 * Config validity banner.
 *
 * Rendered when any config section is marked 'invalid'. Shows the i18n message
 * and lists any warnings returned by loadConfig.
 */
import type { SectionValidity } from '@/app/store';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import './ConfigBanner.scss';

function hasInvalidSection(validity: SectionValidity | null): boolean {
  if (validity === null) return false;
  return Object.values(validity).some((v) => v === 'invalid');
}

export function ConfigBanner() {
  const validity = useSkillkeeperStore((s) => s.configValidity);
  const warnings = useSkillkeeperStore((s) => s.configWarnings);
  const t = useTranslator();

  if (!hasInvalidSection(validity)) return null;

  return (
    <div role="alert" className="sk-config-banner">
      <strong>{t('config.invalidBanner')}</strong>
      {warnings.length > 0 && (
        <ul className="sk-config-banner__list">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
