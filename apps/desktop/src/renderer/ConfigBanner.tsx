/**
 * Config validity banner.
 *
 * Rendered when any config section is marked 'invalid'. Shows the i18n message
 * and lists any warnings returned by loadConfig.
 */
import type { SectionValidity } from './store';
import { useSkillkeeperStore } from './store';
import { useTranslator } from './useTranslator';

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
    <div
      role="alert"
      style={{
        background: '#7c2d12',
        color: '#fef2f2',
        padding: '8px 16px',
        fontSize: '13px',
        borderBottom: '1px solid #991b1b',
      }}
    >
      <strong>{t('config.invalidBanner')}</strong>
      {warnings.length > 0 && (
        <ul style={{ marginTop: '4px', paddingLeft: '20px' }}>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
