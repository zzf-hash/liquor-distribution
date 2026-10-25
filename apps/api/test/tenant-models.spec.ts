/**
 * LQ1-001: schema 里每个带 tenantId 的模型都必须在 TENANT_MODELS 里。
 * 不连数据库。漏模型时应用层不再注入 where.tenantId, 跨租户查询会漏出去。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TENANT_MODELS } from '../src/prisma/tenant-models';

function modelsWithTenantId(schema: string): string[] {
  const found: string[] = [];
  const re = /^model\s+(\w+)\s+\{/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(schema))) {
    const name = match[1];
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < schema.length && depth > 0) {
      const ch = schema[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const body = schema.slice(match.index + match[0].length, i - 1)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    if (/^\s*tenantId\s+\w+/m.test(body)) found.push(name);
  }
  return found;
}

describe('TENANT_MODELS 与 schema 对齐', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const fromSchema = modelsWithTenantId(schema);

  it('每个带 tenantId 的模型都在 TENANT_MODELS 里, 且没有多余名字', () => {
    expect(fromSchema.length).toBeGreaterThan(0);
    expect([...fromSchema].sort()).toEqual([...TENANT_MODELS].sort());
  });

  it('Expense / Promotion / CapFeePolicy / CapRecycleOrder 在清单内', () => {
    for (const name of ['Expense', 'Promotion', 'CapFeePolicy', 'CapRecycleOrder']) {
      expect(TENANT_MODELS.has(name)).toBe(true);
    }
  });
});
