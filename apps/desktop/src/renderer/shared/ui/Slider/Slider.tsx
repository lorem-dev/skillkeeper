/**
 * Slider: a styled native range input. Generic -- no product knowledge.
 * See design-system.md Section 8.3.
 */
import type { InputHTMLAttributes } from 'react';
import { cx } from '../../lib';
import './Slider.scss';

export type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function Slider({ className, ...rest }: SliderProps) {
  return <input type="range" className={cx('sk-slider', className)} {...rest} />;
}
