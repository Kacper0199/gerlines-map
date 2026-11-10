export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PreferenceStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function readPreference<T extends string>(
  key: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
  storage: PreferenceStorage | undefined = defaultStorage(),
): T {
  try {
    const stored = storage?.getItem(key);
    return isValid(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(
  key: string,
  value: string,
  storage: PreferenceStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    return;
  }
}
