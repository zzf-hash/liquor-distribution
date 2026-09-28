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

/** P1-T01 审批线（后端 ApprovalLine 枚举，五条线+信用放行） */
export const APPROVAL_LINE_LABELS: Record<string, string> = {
  CREDIT_RELEASE: '信用放行',
  PRICE_SPECIAL: '特单价格',
  PRICE_CHANGE: '调价',
  PURCHASE: '采购',
  EXPENSE: '运营费',
  RETURN: '退货',
  STOCKTAKE: '盘点调账',
};

export const APPROVAL_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING: { label: '待审批', color: 'warning' },
  APPROVED: { label: '已通过', color: 'success' },
  REJECTED: { label: '已驳回', color: 'error' },
  EXPIRED_24H: { label: '超时退回', color: 'default' },
};

/** P1-T02 特单状态（草稿灰/待审批橙/通过绿/已转单蓝/驳回红） */
export const SPECIAL_ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  PENDING_PRICE: { label: '待定价审批', color: 'warning' },
  APPROVED: { label: '审批通过', color: 'success' },
  CONVERTED: { label: '已转单', color: 'processing' },
  REJECTED: { label: '已驳回', color: 'error' },
};

export const SPECIAL_ORDER_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'DRAFT', label: '草稿' },
  { key: 'PENDING_PRICE', label: '待定价审批' },
  { key: 'APPROVED', label: '审批通过' },
  { key: 'CONVERTED', label: '已转单' },
  { key: 'REJECTED', label: '已驳回' },
];

/** P1-T03 退货状态（待审批橙→已审批绿→已收货蓝/已取消灰） */
export const RETURN_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_REVIEW: { label: '待审批', color: 'warning' },
  APPROVED: { label: '已审批', color: 'success' },
  RECEIVED: { label: '已收货', color: 'processing' },
  CANCELLED: { label: '已取消', color: 'default' },
};

export const RETURN_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_REVIEW', label: '待审批' },
  { key: 'APPROVED', label: '已审批' },
  { key: 'RECEIVED', label: '已收货' },
  { key: 'CANCELLED', label: '已取消' },
];

/** P1-T05 调价状态（草稿灰/待审批橙/已批绿/已生效蓝/驳回红） */
export const PRICE_CHANGE_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  PENDING: { label: '待审批', color: 'warning' },
  APPROVED: { label: '已批', color: 'success' },
  EFFECTIVE: { label: '已生效', color: 'processing' },
  REJECTED: { label: '驳回', color: 'error' },
  CANCELLED: { label: '已取消', color: 'default' },
};

export const PRICE_CHANGE_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'DRAFT', label: '草稿' },
  { key: 'PENDING', label: '待审批' },
  { key: 'APPROVED', label: '已批' },
  { key: 'EFFECTIVE', label: '已生效' },
  { key: 'REJECTED', label: '驳回' },
  { key: 'CANCELLED', label: '已取消' },
];

/** P1-T04 回包装记录类型（台账 append-only，OUT 冲减为负押金） */
export const PACKAGE_TYPE_META: Record<string, { label: string; color: string }> = {
  WITH_ORDER: { label: '有单回填', color: 'processing' },
  STANDALONE: { label: '无单回收', color: 'success' },
  OUT: { label: '押金退付', color: 'warning' },
};

/** P1-T06 采购类型与状态（F3/F4 审批节点位置不同） */
export const PURCHASE_TYPE_META: Record<string, { label: string; color: string }> = {
  PREPAID: { label: '先付F3', color: 'processing' },
  POSTPAID: { label: '后付F4', color: 'warning' },
};

export const PURCHASE_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  PENDING_APPROVAL: { label: '待审批', color: 'warning' },
  APPROVED: { label: '已审批', color: 'success' },
  PAID: { label: '已付款', color: 'processing' },
  RECEIVED: { label: '已收货', color: 'geekblue' },
  CANCELLED: { label: '已取消', color: 'default' },
};

export const PURCHASE_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'DRAFT', label: '草稿' },
  { key: 'PENDING_APPROVAL', label: '待审批' },
  { key: 'APPROVED', label: '已审批' },
  { key: 'PAID', label: '已付款' },
  { key: 'RECEIVED', label: '已收货' },
  { key: 'CANCELLED', label: '已取消' },
];

/** P1-T07 盘点（Q11：仓管盘→内勤核对→超阈值报老板→调账，双签留痕） */
export const STOCKTAKE_TYPE_META: Record<string, { label: string; color: string }> = {
  SPOT: { label: '抽盘', color: 'processing' },
  FULL: { label: '月末大盘', color: 'purple' },
};

export const STOCKTAKE_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '待录实盘', color: 'default' },
  COUNTED: { label: '已录实盘', color: 'processing' },
  RECONCILED: { label: '已核对', color: 'success' },
  PENDING_APPROVAL: { label: '超阈值待审批', color: 'warning' },
  ADJUSTED: { label: '已调账', color: 'geekblue' },
  CANCELLED: { label: '已取消', color: 'default' },
};

export const STOCKTAKE_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'DRAFT', label: '待录实盘' },
  { key: 'COUNTED', label: '已录实盘' },
  { key: 'RECONCILED', label: '已核对' },
  { key: 'PENDING_APPROVAL', label: '超阈值待审批' },
  { key: 'ADJUSTED', label: '已调账' },
  { key: 'CANCELLED', label: '已取消' },
];

/** P1-T08 优惠（D02：b 除瓶箱后返利 / c 定扣货款；同客户 b/c 互斥） */
export const REBATE_TYPE_META: Record<string, { label: string; color: string }> = {
  B: { label: '除瓶箱返利', color: 'processing' },
  C: { label: '定扣货款', color: 'warning' },
};

export const REBATE_SETTLE_TYPE_META: Record<string, { label: string; color: string }> = {
  GOODS: { label: '货补', color: 'success' },
  INVOICE: { label: '票折', color: 'processing' },
};

export const REBATE_SETTLEMENT_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '待确认', color: 'warning' },
  CONFIRMED: { label: '已确认', color: 'success' },
};

/** P1-T09 绩效工资（D5：工资表一键生成，确认发放后不可复算） */
export const PAYROLL_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '待发放', color: 'warning' },
  CONFIRMED: { label: '已发放', color: 'success' },
};

/** P1-T10 对账单状态（已生成灰→已推送蓝→客户确认绿 / 异议橙→差异已解绿） */
export const STATEMENT_STATUS_META: Record<string, { label: string; color: string }> = {
  GENERATED: { label: '已生成', color: 'default' },
  SENT: { label: '已推送', color: 'processing' },
  CONFIRMED: { label: '客户确认', color: 'success' },
  DISPUTED: { label: '异议', color: 'warning' },
  RESOLVED: { label: '差异已解', color: 'success' },
};

export const STATEMENT_STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: '全部' },
  { key: 'GENERATED', label: '已生成' },
  { key: 'SENT', label: '已推送' },
  { key: 'CONFIRMED', label: '客户确认' },
  { key: 'DISPUTED', label: '异议' },
  { key: 'RESOLVED', label: '差异已解' },
];

/** P1-T10 差异四类（客户异议进工作池：漏单/价格/赠品/退货） */
export const DISPUTE_TYPE_META: Record<string, { label: string; color: string }> = {
  MISSING_ORDER: { label: '漏单', color: 'error' },
  PRICE: { label: '价格', color: 'warning' },
  GIFT: { label: '赠品', color: 'processing' },
  RETURN: { label: '退货', color: 'purple' },
};

export const DISPUTE_STATUS_META: Record<string, { label: string; color: string }> = {
  OPEN: { label: '待处理', color: 'warning' },
  RESOLVED: { label: '已处理', color: 'success' },
};

export function labelOf(map: Record<string, string>, key?: string | null, fallback = '-'): string {
  return (key && map[key]) || fallback;
}
