import { Icon } from './Icon';
import { deltaPercent, formatPercent } from '../lib/format';

/**
 * A change against a baseline. Direction is carried by an arrow *and* a word,
 * never by colour alone.
 */
export function Delta({ value, comparedTo, label, invert }: {
  value: number;
  comparedTo: number | null | undefined;
  label?: string;
  /** Set where a rise is the bad direction (e.g. money still outstanding). */
  invert?: boolean;
}) {
  const pct = deltaPercent(value, comparedTo);
  if (pct === null) {
    return <span className="delta delta--none">{label ? `No ${label.replace(/^vs /, '')} baseline` : 'No baseline'}</span>;
  }
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;
  const good = invert ? !up : up;
  const tone = flat ? 'flat' : good ? 'good' : 'bad';
  return (
    <span className={`delta delta--${tone}`}>
      <Icon name={flat ? 'minus' : up ? 'up' : 'down'} size={13} />
      <span className="delta__value">{flat ? 'level' : formatPercent(Math.abs(pct), 1)}</span>
      {label ? <span className="delta__label">{label}</span> : null}
    </span>
  );
}
