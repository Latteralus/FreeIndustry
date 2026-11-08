import type { AdvanceStopReason, AdvanceTarget, SimulationSpeed } from '../../shared/ipc/clock';
import { SPEED_RATE } from '../../shared/ipc/clock';
import type { WorldSnapshot } from '../../shared/ipc/contract';

/** Display formatting for the simulation clock. Presentation only. */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const two = (value: number) => String(value).padStart(2, '0');

/** "Mon 1 Jan 1996" */
export function formatDate(calendar: WorldSnapshot['clock']['calendar']): string {
  const weekday = WEEKDAYS[calendar.weekday - 1] ?? '?';
  const month = MONTHS[calendar.month - 1] ?? '?';
  return `${weekday} ${calendar.day} ${month} ${calendar.year}`;
}

/** "08:05:00" */
export function formatTime(calendar: WorldSnapshot['clock']['calendar']): string {
  return `${two(calendar.hour)}:${two(calendar.minute)}:${two(calendar.second)}`;
}

const SPEED_NAME: Record<SimulationSpeed, string> = {
  paused: 'Pause',
  normal: 'Normal',
  faster: 'Faster',
  fastest: 'Fastest',
};

export function speedName(speed: SimulationSpeed): string {
  return SPEED_NAME[speed];
}

/** "Normal (20×)" or "Paused". */
export function describeSpeed(speed: SimulationSpeed): string {
  return speed === 'paused' ? 'Paused' : `${SPEED_NAME[speed]} (${SPEED_RATE[speed]}×)`;
}

const TARGET_NAME: Record<AdvanceTarget, string> = {
  step: 'Single step',
  endOfDay: 'End of day',
  endOfWeek: 'End of week',
  nextEvent: 'Next event',
};

export function targetName(target: AdvanceTarget): string {
  return TARGET_NAME[target];
}

const STOP_TEXT: Record<AdvanceStopReason, string> = {
  reached: 'reached',
  notable: 'stopped after an event',
  horizon: 'no event within 30 days',
  interrupted: 'interrupted',
  fault: 'stopped by a simulation fault',
};

export function describeLastStop(stop: WorldSnapshot['clock']['lastStop']): string {
  return stop ? `${TARGET_NAME[stop.until]}: ${STOP_TEXT[stop.reason]}` : '—';
}

/** Simulated milliseconds as "d days hh:mm:ss" for diagnostics. */
export function formatSimDuration(msText: string): string {
  const ms = BigInt(msText);
  const totalSeconds = ms / 1000n;
  const days = totalSeconds / 86_400n;
  const rest = Number(totalSeconds % 86_400n);
  return `${days} d ${two(Math.floor(rest / 3600))}:${two(Math.floor(rest / 60) % 60)}:${two(rest % 60)}`;
}
