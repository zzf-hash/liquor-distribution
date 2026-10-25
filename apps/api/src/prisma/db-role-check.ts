import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotifyService } from '../common/notify.service';
import { TENANT_MODELS } from './tenant-models';
import { PrismaService } from './prisma.service';

export function assessDbRole(
  role: { rolsuper: boolean; rolbypassrls: boolean } | undefined,
  ownedTenantTables: string[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!role) reasons.push('pg_roles 查不到 current_user');
  else {
    if (role.rolsuper) reasons.push('rolsuper 应为 false');
    if (role.rolbypassrls) reasons.push('rolbypassrls 应为 false');
  }
  if (ownedTenantTables.length > 0) reasons.push(`拥有租户表: ${ownedTenantTables.join(',')}`);
  return { ok: reasons.length === 0, reasons };
}

/** 启动自检。角色不对只打 error 并告警, 不拒绝启动。 */
@Injectable()
export class DbRoleCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('DbRole');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      const names = [...TENANT_MODELS];
      const owned = await this.prisma.$queryRaw<Array<{ relname: string }>>`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) = current_user
          AND c.relname IN (${Prisma.join(names)})
      `;
      const verdict = assessDbRole(rows[0], owned.map((row) => row.relname));
      const who = rows[0]?.current_user ?? 'unknown';
      if (verdict.ok) {
        this.logger.log(`数据库角色 ${who} 不是超级用户, 不绕过 RLS, 也不拥有租户表`);
        return;
      }
      const text = verdict.reasons.join('; ');
      this.logger.error(`数据库角色 ${who} 不符合 RLS 基线: ${text}`);
      await this.notify.send('数据库角色不符合 RLS 基线', [`user=${who}`, ...verdict.reasons]).catch(() => false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`数据库角色自检失败: ${message.slice(0, 400)}`);
      await this.notify.send('数据库角色自检失败', [message.slice(0, 300)]).catch(() => false);
    }
  }
}
