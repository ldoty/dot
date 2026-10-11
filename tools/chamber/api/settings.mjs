// Controller settings the page can change, shared by the API (which saves them) and the ingest
// Lambda (which hands them to the board in its reply). The board is the authority: it range-checks
// everything again in applySettings() (firmware/chamber_telemetry) and runs all or nothing.
// These bounds mirror the firmware's so a bad value is refused here first. Keep the two in step.

export const SPEC = [
  // key, group, label, unit, min, max, step, kind
  ['rh_on', 'Humidity', 'Start misting below', '% RH', 50, 94, 0.5, 'num'],
  ['rh_off', 'Humidity', 'Stop a burst at', '% RH', 51, 95, 0.5, 'num'],
  ['mist_burst_s', 'Humidity', 'Mist burst (max)', 's', 5, 60, 1, 'num'],
  ['mist_settle_s', 'Humidity', 'Settle after burst', 's', 30, 900, 5, 'num'],
  ['fae_period_s', 'Fresh air (vent)', 'Vent every', 's', 60, 7200, 30, 'num'],
  ['vent_s', 'Fresh air (vent)', 'Vent length', 's', 10, 600, 5, 'num'],
  ['vent_duty', 'Fresh air (vent)', 'Vent fan speed', '%', 20, 100, 1, 'num'],
  ['vent_settle_s', 'Fresh air (vent)', 'Settle after vent', 's', 0, 600, 5, 'num'],
  ['rest_fan', 'Fan between vents', 'Rest fan speed', '%', 0, 60, 0.5, 'num'],
  ['rest_fan_mist', 'Fan between vents', 'Keep rest fan on while misting', '', 0, 1, 1, 'bool'],
  ['heater_interval_s', 'Sensor heater', 'Pulse every', 's', 60, 3600, 30, 'num'],
  ['heater_hold_s', 'Sensor heater', 'Ignore readings after pulse', 's', 5, 300, 5, 'num'],
  ['light_enabled', 'Light', 'Light schedule on', '', 0, 1, 1, 'bool'],
  ['light_on_h', 'Light', 'On at hour', 'h', 0, 23, 1, 'num'],
  ['light_off_h', 'Light', 'Off at hour', 'h', 0, 23, 1, 'num'],
  ['light_duty', 'Light', 'Brightness', '%', 0, 100, 1, 'num'],
].map(([key, group, label, unit, min, max, step, kind]) => ({ key, group, label, unit, min, max, step, kind }));

const BY_KEY = Object.fromEntries(SPEC.map((s) => [s.key, s]));

/** Only the settings keys of an object (e.g. the board's chamber_cfg record). */
export const settingsOf = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => k in BY_KEY));

/** { values } or { error }. All or nothing, like the firmware. */
export function validate(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { error: 'expected {"values": {...}}' };
  const clean = {};
  for (const [key, raw] of Object.entries(values)) {
    const s = BY_KEY[key];
    if (!s) return { error: `Unknown setting ${key}` };
    let v = typeof raw === 'boolean' ? Number(raw) : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw);
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${s.label}: not a number` };
    if (s.kind === 'bool') v = v ? 1 : 0;
    else if (v < s.min || v > s.max) return { error: `${s.label}: must be ${s.min}–${s.max} ${s.unit}`.trim() };
    clean[key] = v;
  }
  if ('rh_on' in clean && 'rh_off' in clean && clean.rh_off <= clean.rh_on) {
    return { error: 'Stop-burst RH must be above start-misting RH' };
  }
  if ('heater_hold_s' in clean && 'heater_interval_s' in clean && clean.heater_hold_s >= clean.heater_interval_s) {
    return { error: 'Heater hold must be shorter than the pulse interval' };
  }
  return { values: clean };
}

/** The "cfg=<version>;k=v;..." line the board parses, or '' when nothing has been saved. */
export function cfgLine(desired) {
  if (!desired) return '';
  const pairs = Object.keys(desired.values).sort().map((k) => `${k}=${desired.values[k]}`);
  return `cfg=${desired.version};${pairs.join(';')}\n`;
}
