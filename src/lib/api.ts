export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'X-Alpha-Client': 'web', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.error ?? 'La requete a echoue.', response.status);
  return payload as T;
}

export const money = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const date = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Une erreur est survenue.'; }
