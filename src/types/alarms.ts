/** Alarms and timers (services/alarms.rs, alarm.rs). Times are unix ms. */
export interface Alarm {
  id: number;
  label: string;
  /** Local "HH:MM". */
  time: string;
  /** Bit 0 = Monday … bit 6 = Sunday; 0 = once. */
  days: number;
  sound: string;
  volume: number;
  snoozeMinutes: number;
  enabled: boolean;
  snoozedUntil: number | null;
  nextAt: number | null;
}

export type AlarmInput = Pick<Alarm, "label" | "time" | "days" | "sound" | "volume" | "snoozeMinutes">;

export interface Timer {
  id: number;
  label: string;
  durationMs: number;
  /** Set while running. */
  endsAt: number | null;
  /** Set while paused. */
  remainingMs: number | null;
  sound: string;
  volume: number;
}

export type TimerInput = Pick<Timer, "label" | "durationMs" | "sound" | "volume">;

export interface Ringing {
  key: string;
  kind: "alarm" | "timer";
  id: number;
  label: string;
  since: number;
}

export interface AlarmsState {
  alarms: Alarm[];
  timers: Timer[];
  ringing: Ringing[];
  now: number;
}

export interface Sound {
  id: string;
  name: string;
  builtin: boolean;
}
