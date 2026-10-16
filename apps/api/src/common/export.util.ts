import * as XLSX from 'xlsx';
import type { Response } from 'express';

// ═══════════════ M1-5 通用单据导出(服务端 xlsx) ═══════════════
// 统一 ExcelJS 式"列定义 + 行数组"输入, 复用 @/xlsx 依赖(与导入解析同源, 不引新包)。
// 用法: 控制器注入 @Res() 直写二进制(绕过 ResponseInterceptor 的 {code:0} 信封), 前端按 blob 下载。

export interface ExportColumn<T> {
  key: string;
  header: string;
  width?: number;
  /** 行 → 单元格值; 缺省取 (row as any)[key] */
  value?: (row: T) => string | number | null | undefined;
}

export interface ExportSheet<T> {
  name: string; // 工作表名(≤31 字符)
  columns: Array<ExportColumn<T>>;
  rows: T[];
  title?: string; // 首行标题(可选)
}

/** 单元格值统一转字符串(金额保留 2 位由调用方处理) */
function cellOf<T>(col: ExportColumn<T>, row: T): string | number | null {
  const v = col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

export function buildXlsx<T>(sheets: Array<ExportSheet<T>>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const aoa: Array<Array<string | number | null>> = [];
    if (sheet.title) aoa.push([sheet.title]);
    aoa.push(sheet.columns.map((c) => c.header));
    for (const row of sheet.rows) aoa.push(sheet.columns.map((c) => cellOf(c, row)));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (sheet.title) {
      // 标题行合并 + 加粗(xlsx 无样式 API, 用 !merges 占位; 无标题时表头即首行)
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, sheet.columns.length - 1) } }];
    }
    ws['!cols'] = sheet.columns.map((c) => ({ wch: c.width ?? Math.max(8, c.header.length * 2 + 4) }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** 二进制直写(跳过全局信封拦截): 中文文件名走 filename* RFC5987 */
export function sendXlsx(res: Response, filename: string, buffer: Buffer): void {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);
  res.setHeader('Content-Length', buffer.length);
  res.status(200).send(buffer);
}

/** 导出文件名: 单据名_yyyyMMddHHmm.xlsx */
export function exportFilename(docName: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${docName}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}
