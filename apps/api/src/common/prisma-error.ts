/** True when a Prisma write hit a unique index whose name or columns mention `hint`. */
export function isUniqueViolation(e: unknown, hint: string): boolean {
  const err = e as { code?: string; message?: string; meta?: { target?: string | string[] } };
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  const text = `${Array.isArray(target) ? target.join(' ') : String(target ?? '')} ${err.message ?? ''}`.toLowerCase();
  return text.includes(hint.toLowerCase());
}
