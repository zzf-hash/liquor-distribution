/**
 * True when trigger cap_fee_policy_same_tenant rejected the write.
 * Prisma surfaces the RAISE as PrismaClientUnknownRequestError; the Postgres
 * message is embedded in `Error.message` (code P0001 is not `e.code`).
 */
export function isCapFeePolicyTenantTrigger(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e ?? '');
  return message.includes('does not match product tenant')
    || (message.includes('CapFeePolicy product') && message.includes('does not exist'));
}

/** True when a Prisma write hit a unique index whose name or columns mention `hint`. */
export function isUniqueViolation(e: unknown, hint: string): boolean {
  const err = e as { code?: string; message?: string; meta?: { target?: string | string[] } };
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  const text = `${Array.isArray(target) ? target.join(' ') : String(target ?? '')} ${err.message ?? ''}`.toLowerCase();
  return text.includes(hint.toLowerCase());
}
