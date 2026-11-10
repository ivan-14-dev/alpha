export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Random per-browser identifier sent to the anti-abuse module (hashed server-side, never linked to identity data). */
export function deviceId(): string {
  try {
    let value = localStorage.getItem('alpha_device');
    if (!value) { value = crypto.randomUUID(); localStorage.setItem('alpha_device', value); }
    return value;
  } catch {
    return 'unavailable';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const json = !!options.body && !(options.body instanceof FormData);
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'X-Alpha-Client': 'web', 'X-Alpha-Device': deviceId(), ...(json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new ApiError(payload.error ?? 'La requete a echoue.', response.status);
  return payload as T;
}

/** Formats minor units. Zero-decimal currencies (XAF, XOF...) are handled by Intl. */
export const money = (minor: number, currency = 'EUR') => {
  const digits = new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const major = minor / 10 ** digits;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: digits && minor % 10 ** digits ? digits : 0 }).format(major);
};
export const date = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
export const dateTime = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Une erreur est survenue.'; }
