// 业务枚举中文标签：与后端 Prisma 枚举值一一对应（订单状态口径=src/statemachine/order-state.ts）

/** 进行中蓝 / 成功绿 / 风险红 / 灰（antd Tag 色系） */
export const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_CONFIRM: { label: '待确认', color: 'processing' },
  CONFIRMED: { label: '已确认', color: 'processing' },
  OUTBOUND: { label: '已出库', color: 'processing' },
  DELIVERING: { label: '配送中', color: 'processing' },
  SIGNED: { label: '已签收', color: 'success' },
  SETTLED: { label: '已销账', color: 'success' },
  CANCELLED: { label: '已取消', color: 'default' },
  REJECTED: { label: '已拒收', color: 'error' },
};

export const ORDER_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_CONFIRM', label: '待确认' },
  { key: 'CONFIRMED', label: '已确认' },
  { key: 'OUTBOUND', label: '出库' },
  { key: 'DELIVERING', label: '配送' },
  { key: 'SIGNED', label: '签收' },
  { key: 'SETTLED', label: '已销账' },
  { key: 'CANCELLED', label: '取消' },
  { key: 'REJECTED', label: '拒收' },
];

export const SOURCE_LABELS: Record<string, string> = {
  CLERK: '内勤开单',
  REP: '业务员代下',
  CUSTOMER: '客户商城',
};

export const SIGN_MODE_LABELS: Record<string, string> = {
  E_SIGN: '网签',
  PAPER: '纸单',
};

export const PRICE_LEVEL_LABELS: Record<string, string> = {
  COST: '成本价',
  TIER1: '一批价',
  TIER2: '二批价',
  TERMINAL: '终端供货价',
  RETAIL: '零售指导价',
  CUSTOMER_EXCLUSIVE: '客户专属价',
};

export const PRICE_UNIT_LABELS: Record<string, string> = {
  BASE: '主单位（箱）',
  MIN: '最小单位（瓶）',
};

export const PRICE_TYPE_LABELS: Record<string, string> = {
  CUSTOMER_EXCLUSIVE: '客户专属价',
  TIER1: '一批价',
  TIER2: '二批价',
  TERMINAL: '终端供货价',
  RETAIL: '零售指导价',
  SPECIAL: '特批价',
  MANUAL: '手工价',
};

export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  BAIJIU: '白酒',
  PIJIU: '啤酒',
  HONGJIU: '红酒',
  YANGJIU: '洋酒',
  YINLIAO: '饮料',
  QITA: '其他',
};

export const PRODUCT_STATUS_META: Record<string, { label: string; color: string }> = {
  ON_SALE: { label: '在售', color: 'success' },
  OFF_SALE: { label: '停售', color: 'default' },
};

export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  YANJIUDIAN: '烟酒店',
  CHAOSHI: '超市',
  CANYIN: '餐饮',
  PIFA: '批发',
  YECHANG: '夜场',
  QIYE: '企事业单位',
  QITA: '其他',
};

export const SETTLEMENT_LABELS: Record<string, string> = {
  CASH: '现结',
  MONTHLY: '月结',
};

export const ONBOARDING_META: Record<string, { label: string; color: string }> = {
  REP_DRAFT: { label: '业务员录入', color: 'default' },
  CLERK_CONFIRMED: { label: '内勤已确认', color: 'processing' },
  PENDING_OWNER: { label: '待老板终审', color: 'warning' },
  ACTIVE: { label: '已生效', color: 'success' },
  REJECTED: { label: '已驳回', color: 'error' },
};

/** 应收账龄分档（后端 AgingBucket：not_due/d1_30/d31_60/d61_90/d90p/disputed） */
export const AR_BUCKET_TABS: Array<{ key: string; label: string }> = [
  { key: 'not_due', label: '未到期' },
  { key: 'd1_30', label: '逾期1-30天' },
  { key: 'd31_60', label: '逾期31-60天' },
  { key: 'd61_90', label: '逾期61-90天' },
  { key: 'd90p', label: '逾期90天以上' },
  { key: 'disputed', label: '争议' },
];

export const IMPORT_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'PRODUCT', label: '商品' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'PRICE', label: '价格' },
  { value: 'INVENTORY', label: '期初库存' },
  { value: 'RECEIVABLE', label: '期初应收' },
];

export const IMPORT_LEVEL_META: Record<string, { label: string; color: string }> = {
  REJECT_BATCH: { label: '拒批', color: 'error' },
  REJECT_ROW: { label: '拒行', color: 'error' },
  WARN: { label: '警告', color: 'warning' },
};

export function labelOf(map: Record<string, string>, key?: string | null, fallback = '-'): string {
  return (key && map[key]) || fallback;
}
