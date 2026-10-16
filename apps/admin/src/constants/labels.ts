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

export const ORDER_STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PENDING_CONFIRM', label: '待确认' },
  { value: 'CONFIRMED', label: '已确认' },
  { value: 'OUTBOUND', label: '出库' },
  { value: 'DELIVERING', label: '配送' },
  { value: 'SIGNED', label: '签收' },
  { value: 'SETTLED', label: '已销账' },
  { value: 'CANCELLED', label: '取消' },
  { value: 'REJECTED', label: '拒收' },
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

/** 应收账龄分档（后端 AgingBucket：not_due/b1/b2/b3/b4/disputed）。
 * M9-3：档位上限租户级可配（默认 30/50/90，Q1 已确认），tab 文案按配置生成——
 * 页面用 agingApi.get() 拉配置后调 arBucketTabs()；未拉到配置时用默认档位。 */
export interface AgingBucketCfg {
  b1: number;
  b2: number;
  b3: number;
}

export const DEFAULT_AR_BUCKET_CFG: AgingBucketCfg = { b1: 30, b2: 50, b3: 90 };

export function arBucketTabs(cfg: AgingBucketCfg = DEFAULT_AR_BUCKET_CFG): Array<{ value: string; label: string }> {
  return [
    { value: 'not_due', label: '未到期' },
    { value: 'b1', label: `逾期1-${cfg.b1}天` },
    { value: 'b2', label: `逾期${cfg.b1 + 1}-${cfg.b2}天` },
    { value: 'b3', label: `逾期${cfg.b2 + 1}-${cfg.b3}天` },
    { value: 'b4', label: `逾期${cfg.b3}天以上` },
    { value: 'disputed', label: '争议' },
  ];
}

/** 未拉到配置时的兜底 tab（与后端 DEFAULT_AGING_CONFIG 一致） */
export const AR_BUCKET_TABS: Array<{ value: string; label: string }> = arBucketTabs();

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

// ───────────────────────── B组 费用域 ─────────────────────────

/** 费用科目（后端 ExpenseCategory；客户级科目可冲抵货款；CAP_FEE/REBATE 只由系统链路生成） */
export const EXPENSE_CATEGORY_META: Record<string, { label: string; color: string; customerLevel: boolean }> = {
  OFFICE: { label: '办公费用', color: 'default', customerLevel: false },
  FUEL_TOLL: { label: '油费路桥', color: 'default', customerLevel: false },
  REPAIR: { label: '车辆维修', color: 'default', customerLevel: false },
  HANDLING: { label: '装卸', color: 'default', customerLevel: false },
  UTILITY: { label: '水电', color: 'default', customerLevel: false },
  DISPLAY: { label: '陈列费', color: 'blue', customerLevel: true },
  ENTRY: { label: '进店费', color: 'blue', customerLevel: true },
  CAP_FEE: { label: '开瓶费', color: 'purple', customerLevel: true },
  REBATE: { label: '返利现金', color: 'geekblue', customerLevel: true },
  OTHER: { label: '其他', color: 'default', customerLevel: false },
};

export const EXPENSE_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_APPROVAL: { label: '待审批', color: 'warning' },
  APPROVED: { label: '已批待付', color: 'processing' },
  PAID: { label: '已付款', color: 'success' },
  REJECTED: { label: '已驳回', color: 'error' },
  CANCELLED: { label: '已取消', color: 'default' },
};

export const EXPENSE_PAY_MODE_LABELS: Record<string, string> = {
  CASH: '现金/转账',
  AR_OFFSET: '冲抵货款',
};

export const CAP_RECYCLE_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_CONFIRM: { label: '待确认', color: 'warning' },
  CONFIRMED: { label: '已兑付', color: 'success' },
  CANCELLED: { label: '已取消', color: 'default' },
};

/** P1-T02 特单状态（草稿灰/待审批橙/通过绿/已转单蓝/驳回红） */
export const SPECIAL_ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  PENDING_PRICE: { label: '待定价审批', color: 'warning' },
  APPROVED: { label: '审批通过', color: 'success' },
  CONVERTED: { label: '已转单', color: 'processing' },
  REJECTED: { label: '已驳回', color: 'error' },
};

export const SPECIAL_ORDER_STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PENDING_PRICE', label: '待定价审批' },
  { value: 'APPROVED', label: '审批通过' },
  { value: 'CONVERTED', label: '已转单' },
  { value: 'REJECTED', label: '已驳回' },
];

/** P1-T03 退货状态（待审批橙→已审批绿→已收货蓝/已取消灰） */
export const RETURN_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_REVIEW: { label: '待审批', color: 'warning' },
  APPROVED: { label: '已审批', color: 'success' },
  RECEIVED: { label: '已收货', color: 'processing' },
  CANCELLED: { label: '已取消', color: 'default' },
};

export const RETURN_STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PENDING_REVIEW', label: '待审批' },
  { value: 'APPROVED', label: '已审批' },
  { value: 'RECEIVED', label: '已收货' },
  { value: 'CANCELLED', label: '已取消' },
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

export const PRICE_CHANGE_STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PENDING', label: '待审批' },
  { value: 'APPROVED', label: '已批' },
  { value: 'EFFECTIVE', label: '已生效' },
  { value: 'REJECTED', label: '驳回' },
  { value: 'CANCELLED', label: '已取消' },
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

export const PURCHASE_STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PENDING_APPROVAL', label: '待审批' },
  { value: 'APPROVED', label: '已审批' },
  { value: 'PAID', label: '已付款' },
  { value: 'RECEIVED', label: '已收货' },
  { value: 'CANCELLED', label: '已取消' },
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

export const STOCKTAKE_STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'DRAFT', label: '待录实盘' },
  { value: 'COUNTED', label: '已录实盘' },
  { value: 'RECONCILED', label: '已核对' },
  { value: 'PENDING_APPROVAL', label: '超阈值待审批' },
  { value: 'ADJUSTED', label: '已调账' },
  { value: 'CANCELLED', label: '已取消' },
];

/** P1-T08 优惠（D02：b 除瓶箱后返利 / c 定扣货款；同客户 b/c 互斥） */
export const REBATE_TYPE_META: Record<string, { label: string; color: string }> = {
  B: { label: '除瓶箱返利', color: 'processing' },
  C: { label: '定扣货款', color: 'warning' },
};

export const REBATE_SETTLE_TYPE_META: Record<string, { label: string; color: string }> = {
  GOODS: { label: '货补', color: 'success' },
  INVOICE: { label: '票折', color: 'processing' },
  CASH: { label: '现金', color: 'gold' },
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

/** P1-T12 草稿来源（语音=客户端转写文本 / 拍照=图存人工辅助 / 文字=微信单粘贴） */
export const DRAFT_SOURCE_META: Record<string, { label: string; color: string }> = {
  VOICE: { label: '语音', color: 'purple' },
  PHOTO: { label: '拍照', color: 'cyan' },
  TEXT: { label: '文字', color: 'default' },
};

/** P1-T12 草稿状态（待确认橙→已转单绿/已废弃灰）；CONFIRMED 只建 PENDING_CONFIRM 订单 */
export const DRAFT_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_REVIEW: { label: '待确认', color: 'warning' },
  CONFIRMED: { label: '已转单', color: 'success' },
  DISCARDED: { label: '已废弃', color: 'default' },
};

export function labelOf(map: Record<string, string>, key?: string | null, fallback = '-'): string {
  return (key && map[key]) || fallback;
}
