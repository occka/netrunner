export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  volume: number;
  muted: boolean;
  peak: number;
}

export interface AudioDevices {
  outputs: AudioDevice[];
  inputs: AudioDevice[];
}

export interface AudioSession {
  id: string;
  pid: number;
  name: string;
  volume: number;
  muted: boolean;
  peak: number;
  system: boolean;
}
