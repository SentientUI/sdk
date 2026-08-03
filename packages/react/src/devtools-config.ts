/** Provider → devtools config handoff. Window-backed: the /devtools entry is a
 * separate bundle and cannot share the provider's React context instance. */
export type DevtoolsConfig = {
  apiKey: string;
  apiBaseUrl: string;
  isLocal: boolean;
};

type ConfigWindow = Window & { __sentient_devtools_config?: DevtoolsConfig };

export function publishDevtoolsConfig(config: DevtoolsConfig): void {
  if (typeof window === 'undefined') return;
  (window as ConfigWindow).__sentient_devtools_config = config;
}

export function readDevtoolsConfig(): DevtoolsConfig | null {
  if (typeof window === 'undefined') return null;
  return (window as ConfigWindow).__sentient_devtools_config ?? null;
}
