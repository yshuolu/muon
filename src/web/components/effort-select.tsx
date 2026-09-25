import type { Provider } from '../../shared/types';
import { EFFORT_LEVELS } from '../../shared/effort';

/** Picks a thinking effort for one agent; the empty choice returns to the agent's configured default. */
export function EffortSelect({ provider, value, defaultLevel, disabled, label, className, onChange }: {
  provider: Provider; value: string | null | undefined; defaultLevel: string; disabled?: boolean; label: string; className?: string;
  onChange: (effort: string | null) => void;
}) {
  const levels = EFFORT_LEVELS[provider];
  const current = value && levels.includes(value) && value !== defaultLevel ? value : '';
  return <select className={className ?? 'chief-model-control'} aria-label={label} title="Thinking effort" value={current} disabled={disabled} onChange={event => onChange(event.target.value || null)}>
    <option value="">{defaultLevel} (default)</option>
    {levels.filter(level => level !== defaultLevel).map(level => <option key={level} value={level}>{level}</option>)}
  </select>;
}
