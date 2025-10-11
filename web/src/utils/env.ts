export function getEnv(key: string, defaultValue: string = ''): string {
  const value = import.meta.env[key];
  return value !== undefined ? String(value) : defaultValue;
}