/**
 * Hairline divider. Generic -- no product knowledge.
 */
import { cx } from '../../lib';
import './Divider.scss';

export interface DividerProps {
  readonly className?: string;
}

export function Divider({ className }: DividerProps) {
  return <hr className={cx('sk-divider', className)} />;
}
