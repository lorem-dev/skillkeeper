/**
 * Segmented control. A single-choice control where the selected pill slides
 * between segments (Framer Motion shared layout). Generic -- no product
 * knowledge. See docs/ui/components.md and design-system.md Section 8.3.
 */
import { useId } from 'react';
import { motion } from 'motion/react';
import { cx, SK_EASE, SK_DURATION } from '../../lib';
import './SegmentedControl.scss';

export interface SegmentOption {
  readonly value: string;
  readonly label: string;
}

export interface SegmentedControlProps {
  readonly options: readonly SegmentOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Accessible group label. */
  readonly label?: string;
  readonly className?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps) {
  const groupId = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cx('sk-segmented', className)}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cx('sk-segmented__option', selected && 'sk-segmented__option--selected')}
            onClick={() => onChange(o.value)}
          >
            {selected && (
              <motion.span
                layoutId={`sk-segmented-${groupId}`}
                className="sk-segmented__pill"
                transition={{ duration: SK_DURATION.fast, ease: SK_EASE }}
              />
            )}
            <span className="sk-segmented__text">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
