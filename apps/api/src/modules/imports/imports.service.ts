import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AuditAction } from '../../audit/audit.service';
import type { AuthUser } from '../../common/current-user.decorator';
import { priceUnitErrorMessage, toPriceUnit } from '@liquor/shared';

// 预览文件缓存目录: preview 落盘原始文件, commit 重放写入(不进 git, 重启丢失=重新预览)
const IMPORT_DIR = join(tmpdir(), 'liquor-imports');

// ═══════════════ P0-T13 存量迁移: Excel 五类导入 ═══════════════
// 模板: docs/M0/导入模板/*.xlsx (列定义以 docs/M0/导入模板字段规范.md 为准)
// 校验: R-拒批(文件内主键重复→整批不写入) / R-拒行(进差异报告) / R-警告(商户批注后放行)
// 提交顺序: 商品→客户→价格→期初库存→期初应收(外键依赖链)
// 回滚: 已提交批次作废走冲正流水不改库(库存/应收=REVERSAL 流水; 主数据不支持下批回滚→人工修正)

export type ImportKind = 'PRODUCT' | 'CUSTOMER' | 'PRICE' | 'INVENTORY' | 'RECEIVABLE';

interface RowErr { rowNo: number; rowKey: string | null; level: 'REJECT_BATCH' | 'REJECT_ROW' | 'WARN'; reasonCode: string; message: string; raw?: unknown }
interface ParsedRow { rowNo: number; cells: Record<string, string>; }

const CATEGORY_MAP: Record<string, string> = { 白酒: 'BAIJIU', 啤酒: 'PIJIU', 红酒: 'HONGJIU', 洋酒: 'YANGJIU', 饮料: 'YINLIAO', 其他: 'QITA' };
const CUSTOMER_TYPE_MAP: Record<string, string> = { 烟酒店: 'YANJIUDIAN', 超市: 'CHAOSHI', 餐饮: 'CANYIN', 批发: 'PIFA', 夜场: 'YECHANG', 企事业单位: 'QIYE', 其他: 'QITA' };
const PRICE_LEVEL_MAP: Record<string, string> = { 成本价: 'COST', 一批价: 'TIER1', 二批价: 'TIER2', 终端供货价: 'TERMINAL', 零售指导价: 'RETAIL', 客户专属价: 'CUSTOMER_EXCLUSIVE' };
const YES_NO = (v: string): boolean | null => (v === '是' ? true : v === '否' ? false : null);

function parseDate(v: string): Date | null {
  if (!v) return null;
  const d = dayjs(v);
  return d.isValid() ? d.toDate() : null;
}
function num(v: string): number | null {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,\s¥]/g, ''));
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────── 解析(xlsx/csv 同构) ───────────────
  private parse(buffer: Buffer): ParsedRow[] {
    const wb = XLSX.read(buffer, { type: 'buffer', codepage: 65001, cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new BadRequestException('文件无工作表');
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
    return rows.map((r, i) => {
      const cells: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) cells[String(k).trim()] = String(v ?? '').trim();
      return { rowNo: i + 2, cells }; // +1 表头 +1 转 1 基
    }).filter((r) => Object.values(r.cells).some((v) => v !== ''));
  }

  private req(cells: Record<string, string>, key: string, rowNo: number, errs: RowErr[], kind: string): string | null {
    const v = cells[key];
    if (!v) { errs.push({ rowNo, rowKey: null, level: 'REJECT_ROW', reasonCode: 'REQUIRED', message: `${kind}: 列「${key}」必填缺失` }); return null; }
    return v;
  }

  // ─────────────── P0-07 ①: 预览校验(差异报告, 不写入) ───────────────
  async preview(user: AuthUser, kind: ImportKind, fileName: string, buffer: Buffer): Promise<unknown> {
    const rows = this.parse(buffer);
    if (rows.length === 0) throw new BadRequestException('无数据行');
    const errs: RowErr[] = [];
    // 各类型校验(字段规范 §2)
    const validated = await this.validate(user, kind, rows, errs);
    const rejectBatch = errs.filter((e) => e.level === 'REJECT_BATCH');
    const rejectRow = errs.filter((e) => e.level === 'REJECT_ROW');
    const warn = errs.filter((e) => e.level === 'WARN');
    const passed = validated.length - rejectRow.length;

    // 同一秒内连续预览会撞 (tenantId, batchNo)。秒级时间后面再加 4 字节随机后缀。
    const batchNo = `IMP${dayjs().format('YYYYMMDDHHmmss')}-${kind.slice(0, 3)}-${randomBytes(4).toString('hex')}`;
    const snapshotDate = kind === 'INVENTORY' ? parseDate(rows[0].cells['盘点基准日*'] ?? rows[0].cells['盘点基准日'] ?? '') : null;
    if (kind === 'INVENTORY') {
      const dates = new Set(rows.map((r) => r.cells['盘点基准日*'] ?? r.cells['盘点基准日'] ?? ''));
      if (dates.size > 1) errs.push({ rowNo: 0, rowKey: null, level: 'REJECT_BATCH', reasonCode: 'SNAPSHOT_DATE', message: '全批盘点基准日不一致(期初口径唯一性)' });
    }
    const batch = await this.prisma.importBatch.create({
      data: {
        tenantId: user.tenantId, batchNo, kind, fileName, status: rejectBatch.length ? 'UPLOADED' : 'PREVIEWED',
        totalRows: rows.length, passedRows: passed, rejectedRows: rejectRow.length, warnedRows: warn.length,
        snapshotDate, report: { rejectBatch, rejectRow, warn, summary: { total: rows.length, passed, rejected: rejectRow.length, warned: warn.length } } as never,
        createdBy: user.id,
      },
    });
    if (errs.length) {
      await this.prisma.importRowError.createMany({
        data: errs.map((e) => ({ tenantId: user.tenantId, batchId: batch.id, rowNo: e.rowNo, rowKey: e.rowKey, level: e.level, reasonCode: e.reasonCode, message: e.message, raw: (e.raw ?? undefined) as never })),
      });
    }
    mkdirSync(IMPORT_DIR, { recursive: true });
    writeFileSync(join(IMPORT_DIR, batchNo), buffer); // commit 重放用
    await this.audit.log({ user, action: AuditAction.IMPORT_PREVIEW, entityType: 'ImportBatch', entityId: batch.id, after: { batchNo, kind, total: rows.length, rejected: rejectRow.length, warned: warn.length, rejectBatch: rejectBatch.length } });
    return {
      batchNo, kind, total: rows.length, passed, rejected: rejectRow.length, warned: warn.length,
      rejectBatch: rejectBatch.slice(0, 20), rejectRow: rejectRow.slice(0, 50), warn: warn.slice(0, 50),
      status: rejectBatch.length ? '整批拒(文件内主键重复), 修正后重传' : rejectRow.length === 0 ? '可提交' : '存在拒行, 修正后重传整文件(不做行级修补)',
    };
  }

  private async validate(user: AuthUser, kind: ImportKind, rows: ParsedRow[], errs: RowErr[]): Promise<ParsedRow[]> {
    const seen = new Map<string, number>(); // 文件内主键 → 首现行号
    const dupCheck = (key: string, rowNo: number): boolean => {
      const first = seen.get(key);
      if (first !== undefined) {
        errs.push({ rowNo, rowKey: key, level: 'REJECT_BATCH', reasonCode: 'DUP_KEY', message: `主键「${key}」与第 ${first} 行重复(整批拒)` });
        return false;
      }
      seen.set(key, rowNo);
      return true;
    };

    if (kind === 'PRODUCT') {
      for (const r of rows) {
        const code = this.req(r.cells, '商品编码*', r.rowNo, errs, '商品');
        if (!code) continue;
        dupCheck(code, r.rowNo);
        const exists = await this.prisma.product.findFirst({ where: { skuCode: code } });
        if (exists) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'DB_DUP', message: `商品编码 ${code} 库内已存在(R-拒行)` });
        if (!this.req(r.cells, '商品名称*', r.rowNo, errs, '商品')) continue;
        if (!CATEGORY_MAP[r.cells['品类*'] ?? '']) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: `品类「${r.cells['品类*']}」无效` });
        const pack = num(r.cells['换算率*'] ?? '');
        if (!pack || pack <= 0) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'AMOUNT_INVALID', message: '换算率须为正整数' });
        if (r.cells['状态'] && !['在售', '停售'].includes(r.cells['状态'])) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: '状态仅 在售/停售' });
      }
    } else if (kind === 'CUSTOMER') {
      for (const r of rows) {
        const code = this.req(r.cells, '客户编码*', r.rowNo, errs, '客户');
        if (!code) continue;
        dupCheck(code, r.rowNo);
        const exists = await this.prisma.customer.findFirst({ where: { code } });
        if (exists) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'DB_DUP', message: `客户编码 ${code} 库内已存在` });
        if (!this.req(r.cells, '店名*', r.rowNo, errs, '客户')) continue;
        if (!CUSTOMER_TYPE_MAP[r.cells['客户类型*'] ?? '']) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: '客户类型无效' });
        const settle = r.cells['结算方式*'];
        if (!['现结', '月结'].includes(settle ?? '')) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: '结算方式仅 现结/月结' });
        const terms = num(r.cells['账期天数'] ?? '0') ?? 0;
        if (settle === '月结' && terms <= 0) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'AMOUNT_INVALID', message: '月结客户账期天数必填>0' });
        if (settle === '月结' && !(num(r.cells['信用额度'] ?? '0') ?? 0)) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'WARN', reasonCode: 'NO_CREDIT', message: '月结客户无信用额度(待确认)' });
        if (!['网签', '纸单'].includes(r.cells['签收方式*'] ?? '')) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: '签收方式仅 网签/纸单' });
        const sp = r.cells['责任业务员*'];
        if (sp) {
          const u = await this.prisma.user.findFirst({ where: { OR: [{ username: sp }, { name: sp }] } });
          if (!u) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'REJECT_ROW', reasonCode: 'REF_MISS', message: `责任业务员「${sp}」不存在(先导员工)` });
        }
        // 同手机号疑似重名(警告, 禁止系统静默去重)
        const phone = r.cells['手机号*'] ?? '';
        if (phone) {
          const same = await this.prisma.customer.findFirst({ where: { phone } });
          if (same) errs.push({ rowNo: r.rowNo, rowKey: code, level: 'WARN', reasonCode: 'PHONE_DUP', message: `手机号与「${same.name}」相同, 疑似重名(人工裁决)` });
        }
      }
    } else if (kind === 'PRICE') {
      for (const r of rows) {
        const cCode = r.cells['客户编码*'] ?? '';
        const pCode = this.req(r.cells, '商品编码*', r.rowNo, errs, '价格');
        const levelName = r.cells['价格类型*'] ?? '';
        if (!pCode || !PRICE_LEVEL_MAP[levelName]) { errs.push({ rowNo: r.rowNo, rowKey: pCode || null, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: `价格类型「${levelName}」无效` }); continue; }
        const isExclusive = PRICE_LEVEL_MAP[levelName] === 'CUSTOMER_EXCLUSIVE';
        if (isExclusive && !cCode) { errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'REQUIRED', message: '客户专属价必须带客户编码' }); continue; }
        const key = `${cCode || '-'}|${pCode}|${r.cells['计价单位*'] ?? ''}|${levelName}|${r.cells['生效日'] ?? ''}`;
        dupCheck(key, r.rowNo);
        const product = await this.prisma.product.findFirst({ where: { skuCode: pCode } });
        if (!product) { errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'REF_MISS', message: `商品 ${pCode} 不在同批且不在库(先导商品)` }); continue; }
        let customer = null as null | { id: string };
        if (cCode) {
          customer = await this.prisma.customer.findFirst({ where: { code: cCode } });
          if (!customer) { errs.push({ rowNo: r.rowNo, rowKey: cCode, level: 'REJECT_ROW', reasonCode: 'REF_MISS', message: `客户 ${cCode} 不在库(先导客户)` }); continue; }
        }
        const price = num(r.cells['价格*'] ?? '');
        if (price === null || price < 0) { errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'AMOUNT_NEG', message: '价格须为非负数' }); continue; }
        const from = parseDate(r.cells['生效日'] ?? dayjs().format('YYYY-MM-DD'));
        const to = parseDate(r.cells['失效日'] ?? '');
        if (r.cells['生效日'] && !from) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'DATE_FMT', message: '生效日格式错(YYYY-MM-DD)' });
        if (from && to && to < from) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'DATE_ORDER', message: '失效日早于生效日' });
        if (isExclusive && !r.cells['审批单号']) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'WARN', reasonCode: 'NO_APPROVAL', message: '专属价无审批单号(待确认)' });
        const unit = toPriceUnit(r.cells['计价单位*'] ?? '');
        if (!unit) {
          errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'ENUM_INVALID', message: priceUnitErrorMessage(r.cells['计价单位*'] ?? '') });
          continue;
        }
        // 同键区间重叠 = 拒后条(字段规范§3: 同(客户,商品,单位,价型,生效日)完全重复拒批; 重叠警告商户裁决)
        if (customer) {
          const overlap = await this.prisma.customerPrice.findFirst({ where: { customerId: customer.id, productId: product.id, unit, validFrom: from ?? undefined } });
          if (overlap) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'DB_DUP', message: '同(客户,商品,单位,生效日)价格已存在' });
        } else {
          const overlap = await this.prisma.price.findFirst({ where: { productId: product.id, unit, levelType: PRICE_LEVEL_MAP[levelName] as never, validFrom: from ?? undefined } });
          if (overlap) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'DB_DUP', message: '同(商品,单位,价型,生效日)价格已存在' });
        }
      }
    } else if (kind === 'INVENTORY') {
      for (const r of rows) {
        const pCode = this.req(r.cells, '商品编码*', r.rowNo, errs, '库存');
        const batchNo = this.req(r.cells, '批次号*', r.rowNo, errs, '库存');
        if (!pCode || !batchNo) continue;
        dupCheck(`${pCode}|${batchNo}`, r.rowNo);
        const product = await this.prisma.product.findFirst({ where: { skuCode: pCode } });
        if (!product) { errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'REF_MISS', message: `商品 ${pCode} 不在库(先导商品)` }); continue; }
        const qty = num(r.cells['数量*'] ?? '');
        if (qty === null || qty <= 0) { errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'AMOUNT_INVALID', message: '数量须为正数(最小单位)' }); continue; }
        const cost = num(r.cells['成本单价*'] ?? '');
        if (cost === null || cost < 0) { errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'AMOUNT_NEG', message: '成本单价须为非负数' }); continue; }
        if (!parseDate(r.cells['盘点基准日*'] ?? '')) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'DATE_FMT', message: '盘点基准日必填(YYYY-MM-DD)' });
        // 啤酒/效期品: 生产日期+到期日必填, 已过期批次拒入(§3)
        if (product.category === 'PIJIU' && (batchNo === '期初' || !r.cells['到期日'])) {
          if (batchNo === '期初') errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'WARN', reasonCode: 'BEER_NO_BATCH', message: '啤酒品建议真实批次+效期' });
        }
        const expiry = parseDate(r.cells['到期日'] ?? '');
        if (expiry && expiry < new Date()) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'EXPIRED', message: '已过期批次拒入' });
        const prod = parseDate(r.cells['生产日期'] ?? '');
        if (prod && expiry && expiry < prod) errs.push({ rowNo: r.rowNo, rowKey: pCode, level: 'REJECT_ROW', reasonCode: 'DATE_ORDER', message: '到期日早于生产日期' });
      }
    } else if (kind === 'RECEIVABLE') {
      for (const r of rows) {
        const cCode = this.req(r.cells, '客户编码*', r.rowNo, errs, '应收');
        const docNo = this.req(r.cells, '原始单据号*', r.rowNo, errs, '应收');
        if (!cCode || !docNo) continue;
        dupCheck(docNo, r.rowNo);
        const customer = await this.prisma.customer.findFirst({ where: { code: cCode } });
        if (!customer) { errs.push({ rowNo: r.rowNo, rowKey: cCode, level: 'REJECT_ROW', reasonCode: 'REF_MISS', message: `客户 ${cCode} 不在库(先导客户)` }); continue; }
        const total = num(r.cells['应收金额*'] ?? '');
        const received = num(r.cells['已收金额*'] ?? '0') ?? 0;
        const openAmt = num(r.cells['未收金额*'] ?? '');
        if (total === null || total <= 0) { errs.push({ rowNo: r.rowNo, rowKey: docNo, level: 'REJECT_ROW', reasonCode: 'AMOUNT_INVALID', message: '应收金额须为正数' }); continue; }
        if (received > total) errs.push({ rowNo: r.rowNo, rowKey: docNo, level: 'REJECT_ROW', reasonCode: 'RECEIVED_GT_TOTAL', message: '已收>应收' });
        if (openAmt === null || Math.abs(openAmt - (total - received)) > 0.005) errs.push({ rowNo: r.rowNo, rowKey: docNo, level: 'REJECT_ROW', reasonCode: 'OPEN_NEQ', message: '未收≠应收−已收(0 容差硬校验)' });
        if (!parseDate(r.cells['单据日期*'] ?? '') || !parseDate(r.cells['到期日*'] ?? '')) errs.push({ rowNo: r.rowNo, rowKey: docNo, level: 'REJECT_ROW', reasonCode: 'DATE_FMT', message: '单据日期/到期日格式错' });
        if (parseDate(r.cells['到期日*'] ?? '') && parseDate(r.cells['单据日期*'] ?? '') && parseDate(r.cells['到期日*'] ?? '')! < parseDate(r.cells['单据日期*'] ?? '')!) errs.push({ rowNo: r.rowNo, rowKey: docNo, level: 'REJECT_ROW', reasonCode: 'DATE_ORDER', message: '到期日早于单据日期' });
      }
    }
    return rows;
  }

  // ─────────────── ②: 批次提交(失败零写入, 重放预览时缓存的原始文件) ───────────────
  async commit(user: AuthUser, batchNo: string, ip?: string): Promise<unknown> {
    const batch = await this.prisma.importBatch.findUnique({ where: { tenantId_batchNo: { tenantId: user.tenantId, batchNo } } });
    if (!batch) throw new NotFoundException('批次不存在');
    if (batch.status !== 'PREVIEWED') throw new ConflictException(`批次状态 ${batch.status}, 仅预览通过可提交`);
    const errors = await this.prisma.importRowError.findMany({ where: { batchId: batch.id, level: 'REJECT_BATCH' } });
    const rowErrs = await this.prisma.importRowError.findMany({ where: { batchId: batch.id, level: 'REJECT_ROW' } });
    if (errors.length || rowErrs.length) throw new ConflictException('存在拒批/拒行, 不可提交');

    const rows = this.parse(readFileSync(join(IMPORT_DIR, batchNo)));
    const bad = new Set(rowErrs.map((e) => e.rowNo));
    const good = rows.filter((r) => !bad.has(r.rowNo));
    let written = 0;
    await this.prisma.$transaction(async (tx) => {
      if (batch.kind === 'PRODUCT') {
        for (const r of good) {
          const code = r.cells['商品编码*'];
          const product = await tx.product.findFirst({ where: { skuCode: code } });
          if (product) continue;
          await tx.product.create({
            data: {
              tenantId: user.tenantId, skuCode: code, name: r.cells['商品名称*'],
              category: (CATEGORY_MAP[r.cells['品类*']] ?? 'QITA') as never,
              brand: r.cells['品牌'] || undefined, baseUnit: r.cells['主单位*'] || '箱', minUnit: '瓶',
              packSize: Math.trunc(num(r.cells['换算率*'] ?? '1') ?? 1), barcode: r.cells['条码'] || undefined,
              abv: num(r.cells['度数'] ?? '') ?? undefined, origin: r.cells['产地'] || undefined,
              supplier: r.cells['供应商'] || undefined, specText: r.cells['规格描述'] || undefined,
              highValue: YES_NO(r.cells['是否高值品'] ?? '') ?? false,
              status: (r.cells['状态'] === '停售' ? 'OFF_SALE' : 'ON_SALE') as never,
            },
          });
          written++;
        }
      } else if (batch.kind === 'CUSTOMER') {
        for (const r of good) {
          const code = r.cells['客户编码*'];
          if (await tx.customer.findFirst({ where: { code } })) continue;
          const sp = r.cells['责任业务员*'];
          const spUser = sp ? await tx.user.findFirst({ where: { OR: [{ username: sp }, { name: sp }] } }) : null;
          await tx.customer.create({
            data: {
              tenantId: user.tenantId, code, name: r.cells['店名*'],
              type: (CUSTOMER_TYPE_MAP[r.cells['客户类型*']] ?? 'QITA') as never,
              contact: r.cells['联系人'] || undefined, phone: r.cells['手机号*'] ?? '',
              region: r.cells['省市区*'] || undefined, address: r.cells['详细地址*'] ?? '',
              abcLevel: r.cells['ABC分级'] || undefined,
              settlement: (r.cells['结算方式*'] === '现结' ? 'CASH' : 'MONTHLY') as never,
              termsDays: Math.trunc(num(r.cells['账期天数'] ?? '0') ?? 0),
              creditLimit: new Prisma.Decimal(num(r.cells['信用额度'] ?? '0') ?? 0),
              receivingWindow: r.cells['收货时段'] || undefined,
              signMode: (r.cells['签收方式*'] === '纸单' ? 'PAPER' : 'E_SIGN') as never,
              printerModel: r.cells['专属打印机型号'] || undefined,
              salespersonId: spUser?.id, bossPhone: r.cells['老板电话'] || undefined,
              licenseNo: r.cells['证照编号'] || undefined,
              // 存量迁移客户视同已终审(字段规范口径), 新增一律走系统开户流程不可被导入绕过
              onboarding: 'ACTIVE', status: (r.cells['状态'] === '禁用' ? 'DISABLED' : 'ACTIVE') as never,
            },
          });
          written++;
        }
      } else if (batch.kind === 'PRICE') {
        for (const r of good) {
          const pCode = r.cells['商品编码*'];
          const product = await tx.product.findFirst({ where: { skuCode: pCode } });
          if (!product) continue;
          const unit = toPriceUnit(r.cells['计价单位*'] ?? '');
          if (!unit) continue;
          const level = PRICE_LEVEL_MAP[r.cells['价格类型*']] as never;
          const price = new Prisma.Decimal(num(r.cells['价格*'] ?? '0') ?? 0);
          const validFrom = parseDate(r.cells['生效日'] ?? '') ?? new Date();
          const validTo = parseDate(r.cells['失效日'] ?? '');
          if (level === 'CUSTOMER_EXCLUSIVE' as never) {
            const customer = await tx.customer.findFirst({ where: { code: r.cells['客户编码*'] } });
            if (!customer) continue;
            await tx.customerPrice.create({
              data: { tenantId: user.tenantId, customerId: customer.id, productId: product.id, unit, price, validFrom, validTo: validTo ?? undefined, approvalRef: r.cells['审批单号'] || undefined, note: r.cells['备注'] || undefined, createdBy: user.id },
            });
          } else {
            await tx.price.create({
              data: { tenantId: user.tenantId, productId: product.id, unit, levelType: level, price, validFrom, validTo: validTo ?? undefined, approvalRef: r.cells['审批单号'] || undefined, note: r.cells['备注'] || undefined, createdBy: user.id },
            });
          }
          written++;
        }
      } else if (batch.kind === 'INVENTORY') {
        for (const r of good) {
          const pCode = r.cells['商品编码*'];
          const product = await tx.product.findFirst({ where: { skuCode: pCode } });
          if (!product) continue;
          const batchNo2 = r.cells['批次号*'];
          const existing = await tx.batchStock.findFirst({ where: { productId: product.id, batchNo: batchNo2 } });
          if (existing) continue;
          const b = await tx.batchStock.create({
            data: {
              tenantId: user.tenantId, productId: product.id, batchNo: batchNo2,
              produceDate: parseDate(r.cells['生产日期'] ?? '') ?? undefined,
              expiryDate: parseDate(r.cells['到期日'] ?? '') ?? undefined,
              location: r.cells['库位'] || undefined,
              unitCost: new Prisma.Decimal(num(r.cells['成本单价*'] ?? '0') ?? 0),
              snapshotDate: parseDate(r.cells['盘点基准日*'] ?? '') ?? undefined,
              isInitial: true,
            },
          });
          await tx.inventoryLedger.create({
            data: { tenantId: user.tenantId, productId: product.id, batchId: b.id, direction: 'IN', qty: new Prisma.Decimal(num(r.cells['数量*'] ?? '0') ?? 0), refType: 'INITIAL_IMPORT', refNo: batch.batchNo, note: r.cells['备注'] || undefined, createdBy: user.id },
          });
          written++;
        }
      } else if (batch.kind === 'RECEIVABLE') {
        for (const r of good) {
          const customer = await tx.customer.findFirst({ where: { code: r.cells['客户编码*'] } });
          if (!customer) continue;
          const docNo = r.cells['原始单据号*'];
          if (await tx.receivable.findFirst({ where: { sourceType: 'INITIAL', sourceDocNo: docNo } })) continue;
          const total = new Prisma.Decimal(num(r.cells['应收金额*'] ?? '0') ?? 0);
          const received = num(r.cells['已收金额*'] ?? '0') ?? 0;
          const ar = await tx.receivable.create({
            data: {
              tenantId: user.tenantId, sourceType: 'INITIAL', sourceDocNo: docNo,
              customerId: customer.id, total,
              dueDate: parseDate(r.cells['到期日*'] ?? '') ?? new Date(),
              disputeFlag: r.cells['争议标记'] === '争议',
              note: r.cells['迁移备注'] || undefined,
              ledger: { create: { tenantId: user.tenantId, direction: 'CHARGE', amount: total, note: `期初导入 ${docNo}`, createdBy: user.id } },
            } as never,
          });
          if (received > 0) {
            await tx.receivableLedger.create({
              data: { tenantId: user.tenantId, receivableId: ar.id, direction: 'SETTLE', amount: new Prisma.Decimal(received), note: '期初已收', createdBy: user.id },
            });
          }
          written++;
        }
      }
      await tx.importBatch.update({ where: { id: batch.id }, data: { status: 'COMMITTED', committedAt: new Date() } });
    });
    await this.audit.log({ user, action: AuditAction.IMPORT_COMMIT, entityType: 'ImportBatch', entityId: batch.id, after: { batchNo, kind: batch.kind, written }, ip });
    return { batchNo, kind: batch.kind, written };
  }

  /** ③: 回滚 = 冲正流水不改库(库存/应收); 主数据批次不支持下批回滚(走人工修正+审计) */
  async rollback(user: AuthUser, batchNo: string, ip?: string): Promise<unknown> {
    const batch = await this.prisma.importBatch.findUnique({ where: { tenantId_batchNo: { tenantId: user.tenantId, batchNo } } });
    if (!batch) throw new NotFoundException('批次不存在');
    if (batch.status !== 'COMMITTED') throw new ConflictException('仅已提交批次可回滚');
    if (batch.kind === 'PRODUCT' || batch.kind === 'CUSTOMER' || batch.kind === 'PRICE') {
      throw new ConflictException('主数据批次无流水, 作废走人工修正(修改/停用/关闭版本), 不做批回滚');
    }
    let reversed = 0;
    await this.prisma.$transaction(async (tx) => {
      if (batch.kind === 'INVENTORY') {
        const ledgers = await tx.inventoryLedger.findMany({ where: { refType: 'INITIAL_IMPORT', refNo: batch.batchNo } });
        for (const l of ledgers) {
          await tx.inventoryLedger.create({
            data: { tenantId: user.tenantId, productId: l.productId, batchId: l.batchId, direction: 'OUT', qty: l.qty, refType: 'REVERSAL_IN', refNo: batch.batchNo, note: `导入批次冲正 ${batch.batchNo}`, createdBy: user.id },
          });
          reversed++;
        }
      } else {
        const ars = await tx.receivable.findMany({ where: { ledger: { some: { direction: 'CHARGE', note: { contains: batch.batchNo } } } } });
        for (const ar of ars) {
          await tx.receivableLedger.create({
            data: { tenantId: user.tenantId, receivableId: ar.id, direction: 'REVERSAL', amount: ar.total, note: `导入批次冲正 ${batch.batchNo}(整单作废)`, createdBy: user.id },
          });
          reversed++;
        }
      }
      await tx.importBatch.update({ where: { id: batch.id }, data: { status: 'ROLLED_BACK', rolledBackAt: new Date() } });
    });
    await this.audit.log({ user, action: AuditAction.IMPORT_ROLLBACK, entityType: 'ImportBatch', entityId: batch.id, before: { status: 'COMMITTED' }, after: { status: 'ROLLED_BACK', reversed }, ip });
    return { batchNo, reversed };
  }

  async list(page = 1, pageSize = 20): Promise<unknown> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.importBatch.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.importBatch.count(),
    ]);
    return { items, total };
  }

  async report(user: AuthUser, batchNo: string): Promise<unknown> {
    const batch = await this.prisma.importBatch.findUnique({ where: { tenantId_batchNo: { tenantId: user.tenantId, batchNo } }, include: { rowErrors: true } });
    if (!batch) throw new NotFoundException('批次不存在');
    return batch;
  }
}
