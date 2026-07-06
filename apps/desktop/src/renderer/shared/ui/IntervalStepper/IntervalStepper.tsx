/**
 * IntervalStepper: pick a duration in minutes, entered as a number plus a unit
 * (m or h). Generic -- no product knowledge. The stored value is always minutes;
 * switching to hours snaps to whole hours. Clamped to [minMinutes, maxMinutes].
 */
import { useState } from 'react';
import { Stepper } from '../Stepper';
import { SegmentedControl } from '../SegmentedControl';
import './IntervalStepper.scss';

export interface IntervalStepperProps {
  readonly minutes: number;
  readonly onChange: (minutes: number) => void;
  readonly minMinutes?: number;
  readonly maxMinutes?: number;
  /** Accessible group label. */
  readonly label?: string;
  /** Unit labels (translated): minutes and hours. */
  readonly minutesUnitLabel?: string;
  readonly hoursUnitLabel?: string;
  readonly decreaseLabel?: string;
  readonly increaseLabel?: string;
  readonly disabled?: boolean;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export function IntervalStepper({
  minutes,
  onChange,
  minMinutes = 1,
  maxMinutes = 23 * 60,
  label,
  minutesUnitLabel = 'm',
  hoursUnitLabel = 'h',
  decreaseLabel,
  increaseLabel,
  disabled,
}: IntervalStepperProps) {
  // Start in hours when the value is a whole number of hours, else minutes.
  const [unit, setUnit] = useState<'m' | 'h'>(() => (minutes >= 60 && minutes % 60 === 0 ? 'h' : 'm'));
  const isHours = unit === 'h';

  const value = isHours ? Math.round(minutes / 60) : minutes;
  const min = isHours ? Math.max(1, Math.ceil(minMinutes / 60)) : minMinutes;
  const max = isHours ? Math.floor(maxMinutes / 60) : maxMinutes;

  const setValue = (v: number): void => {
    onChange(clamp(isHours ? v * 60 : v, minMinutes, maxMinutes));
  };

  const changeUnit = (u: string): void => {
    const next = u === 'h' ? 'h' : 'm';
    setUnit(next);
    // Snap to the new unit's granularity so the displayed value matches storage.
    if (next === 'h') {
      onChange(clamp(Math.round(minutes / 60), 1, Math.floor(maxMinutes / 60)) * 60);
    } else {
      onChange(clamp(minutes, minMinutes, maxMinutes));
    }
  };

  return (
    <div className="sk-interval-stepper" role="group" aria-label={label}>
      <Stepper
        value={value}
        onChange={setValue}
        min={min}
        max={max}
        disabled={disabled}
        decreaseLabel={decreaseLabel}
        increaseLabel={increaseLabel}
      />
      <SegmentedControl
        options={[
          { value: 'm', label: minutesUnitLabel },
          { value: 'h', label: hoursUnitLabel },
        ]}
        value={unit}
        onChange={changeUnit}
        label={label}
        disabled={disabled}
      />
    </div>
  );
}
