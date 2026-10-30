// 盘点（P1-T07，Q11）：仓管盘 → 内勤核对 → 差异超阈值报老板（STOCKTAKE 审批线）→ 调账，双签留痕。
// 建单即生成批次级账面快照行（countedQty 预填=账面，仓管只改差异行）；
// 超阈值审批：批准→回到已核对可调账 / 驳回→退回重盘；调账=ADJUST 不可变流水（盘盈 IN/盘亏 OUT）。
import { useEffect, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Descriptions, InputNumber, Modal,
  Radio, Select, Space, Steps, Switch, Table, Tag, Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { stocktakesApi, usersApi } from '../../services/api';
import type {
  ProductCategoryDTO,
  StocktakeDTO,
  StocktakeLineDTO,
  StocktakeTypeDTO,
  UserDTO,
} from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import { PRODUCT_CATEGORY_LABELS, STOCKTAKE_STATUS_META, STOCKTAKE_STATUS_TABS, STOCKTAKE_TYPE_META } from '../../constants/labels';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';

const POS = '#389e0d'; // 盘盈绿（资产多出来）
const NEG = '#cf1322'; // 盘亏红（与订单池红字同色）

/** 状态流（静态口径图）：超阈值才走 PENDING_APPROVAL 节点 */
const FLOW_STEPS = ['建单·账面快照', '仓管录实盘', '内勤核对', '超阈值报老板', '调账落账'];
const STATUS_STEP: Record<string, number> = {
  DRAFT: 0,
  COUNTED: 1,
  RECONCILED: 2,
  PENDING_APPROVAL: 3,
  ADJUSTED: 4,
};

function diffQtyOf(l: StocktakeLineDTO): number {
  return toNum(l.countedQty) - toNum(l.systemQty);
}

/** 差异金额（成本口径）：差异数 × 行单位成本 */
function diffAmountOf(l: StocktakeLineDTO): number {
  return diffQtyOf(l) * toNum(l.unitCost);
}

/** 差异金额配色：盘盈绿 / 盘亏红 / 无差异灰 */
function diffColor(v: number): string | undefined {
  if (v > 0.0001) return POS;
  if (v < -0.0001) return NEG;
  return undefined;
}

/** 商品名挂在批次上（detail/create 响应 include batch.product） */
function lineName(l: StocktakeLineDTO): string {
  return l.batch?.product?.name ?? l.productId;
}
function lineSkuCode(l: StocktakeLineDTO): string | undefined {
  return l.batch?.product?.skuCode;
}
function lineBatchNo(l: StocktakeLineDTO): string {
  return l.batch?.batchNo ?? l.batchId;
}

/** CSV 单元格转义（逗号/引号/换行包裹双引号） */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 差异金额展示（带正负号） */
function fmtSigned(v: number): string {
  const s = v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v > 0 ? `+${s}` : s;
}

export default function StocktakesPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const canCount = role === 'warehouse' || role === 'owner'; // 建单+录实盘（Q11 仓管）
  const canReconcile = role === 'clerk' || role === 'owner'; // 核对+调账（Q11 内勤）
  const [activeStatus, setActiveStatus] = useState('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [countTarget, setCountTarget] = useState<StocktakeDTO | null>(null);
  const [reconcileTarget, setReconcileTarget] = useState<StocktakeDTO | null>(null);
  const [users, setUsers] = useState<UserDTO[]>([]);

  const reload = (): void => setRefreshKey((k) => k + 1);

  // 列表只回传 countedById/reconciledById，名字由员工表前端映射
  useEffect(() => {
    usersApi
      .list()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);
  const userName = (id?: string | null): string => (id ? users.find((u) => u.id === id)?.name ?? id : '-');

  /** 行操作：导出差异清单 CSV（核对后各状态可用） */
  async function exportDiffCsv(r: StocktakeDTO): Promise<void> {
    try {
      const d = await stocktakesApi.detail(r.id);
      const diffs = (d.lines ?? []).filter((l) => Math.abs(diffQtyOf(l)) > 0.0001);
      const header = ['商品', '编码', '批次', '账面数量', '实盘数量', '差异数', '差异金额', '单位成本'];
      const lines = diffs.map((l) => [
        lineName(l),
        lineSkuCode(l) ?? '',
        lineBatchNo(l),
        toNum(l.systemQty),
        toNum(l.countedQty),
        diffQtyOf(l).toFixed(3),
        diffAmountOf(l).toFixed(2),
        toNum(l.unitCost).toFixed(4),
      ].map(csvCell).join(','));
      const blob = new Blob([`﻿${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `清点差异清单_${r.takeNo}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已导出 ${diffs.length} 行差异（${r.takeNo}）`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出差异清单失败');
    }
  }

  /** 调账落账（仅 RECONCILED）：差异行写 ADJUST 流水（盘盈 IN/盘亏 OUT），不可撤销 */
  function adjust(r: StocktakeDTO): void {
    modal.confirm({
      title: `调账落账？${r.takeNo}`,
      content: `差异金额 ${r.diffAmount !== null && r.diffAmount !== undefined ? fmtMoney(r.diffAmount) : '-'}（成本口径）。执行后按差异行写入 ADJUST 不可变流水（盘盈 IN / 盘亏 OUT），账面即时变化，不可撤销。`,
      okText: '确认调账',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await stocktakesApi.adjust(r.id);
          message.success(`调账完成：写入 ${res.adjustedLines} 条 ADJUST 流水（${r.takeNo}）`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '调账失败');
        }
      },
    });
  }

  const columns: ProColumns<StocktakeDTO>[] = [
    { title: '清点单号', dataIndex: 'takeNo', width: 170, render: (_, r) => <Typography.Text copyable>{r.takeNo}</Typography.Text> },
    {
      title: '类型', dataIndex: 'type', width: 110,
      render: (_, r) => {
        const meta = STOCKTAKE_TYPE_META[r.type];
        return <Tag color={meta?.color}>{meta?.label ?? r.type}</Tag>;
      },
    },
    {
      title: '差异金额', dataIndex: 'diffAmount', width: 120, align: 'right',
      render: (_, r) => (r.diffAmount === null || r.diffAmount === undefined
        ? '-'
        : <span style={{ color: diffColor(toNum(r.diffAmount)) }}>{fmtMoney(r.diffAmount)}</span>),
    },
    {
      title: '状态', dataIndex: 'status', width: 130,
      render: (_, r) => {
        const meta = STOCKTAKE_STATUS_META[r.status];
        return (
          <Space size={4}>
            <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>
            {r.thresholdOver && r.status !== 'ADJUSTED' && <Tag color="red">超阈值</Tag>}
          </Space>
        );
      },
    },
    {
      title: '双签（盘/核）', dataIndex: 'countedById', width: 150,
      render: (_, r) => (
        <Space size={0} direction="vertical">
          <span>{userName(r.countedById)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            核：{r.reconciledById ? userName(r.reconciledById) : '未核'}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', valueType: 'option', width: 230,
      render: (_, r) => (
        <Space size={4}>
          {canCount && (r.status === 'DRAFT' || r.status === 'COUNTED') && <a onClick={() => setCountTarget(r)}>录实盘</a>}
          {canReconcile && r.status === 'COUNTED' && <a onClick={() => setReconcileTarget(r)}>核对差异</a>}
          {canReconcile && r.status === 'RECONCILED' && <a onClick={() => adjust(r)}>调账落账</a>}
          {['RECONCILED', 'PENDING_APPROVAL', 'ADJUSTED'].includes(r.status) && (
            <a onClick={() => void exportDiffCsv(r)}><DownloadOutlined /> 差异清单</a>
          )}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer title="清点库存" subTitle="抽查 / 月末大清点 · 仓管清点→内勤核对→超阈值报老板→调账（双签留痕）">
      <Card size="small" title="状态流说明" style={{ marginBottom: 12 }}>
        <Steps
          size="small"
          current={-1}
          items={FLOW_STEPS.map((title) => ({ title }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          差异金额超阈值才报老板（待审批 · 清点库存调账）：批准→回到「已核对」由内勤调账，驳回→退回重盘；调账写 ADJUST 不可变流水，不反改历史单据。
        </Typography.Text>
      </Card>

      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 150 }}
            value={activeStatus}
            onChange={(v) => { setActiveStatus(v); reload(); }}
            options={STOCKTAKE_STATUS_TABS}
          />
          {canCount && <Button type="primary" onClick={() => setCreateOpen(true)}>新建清点</Button>}
        </Space>
        <ProTable<StocktakeDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await stocktakesApi.list({
                status: activeStatus === 'ALL' ? undefined : activeStatus,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载清点单失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          expandable={{ expandedRowRender: (r) => <StocktakeDetailCard record={r} /> }}
        />
      </Card>

      <CreateStocktakeModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); reload(); }}
      />
      <CountStocktakeModal
        target={countTarget}
        onClose={() => setCountTarget(null)}
        onDone={() => { setCountTarget(null); reload(); }}
      />
      <ReconcileStocktakeModal
        target={reconcileTarget}
        onClose={() => setReconcileTarget(null)}
        onDone={() => { setReconcileTarget(null); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 行展开：盘点明细（进度 + 快照行差异表） ─────────────────────────

function StocktakeDetailCard({ record }: { record: StocktakeDTO }): JSX.Element {
  const [detail, setDetail] = useState<StocktakeDTO | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    stocktakesApi
      .detail(record.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '加载明细失败'); });
    return () => { alive = false; };
  }, [record]);

  if (error) return <Alert type="error" message={error} />;
  if (!detail) return <Card size="small" loading />;

  const step = STATUS_STEP[detail.status];
  const lines = detail.lines ?? [];
  const diffRows = lines.filter((l) => Math.abs(diffQtyOf(l)) > 0.0001);
  const diffSum = diffRows.reduce((s, l) => s + diffAmountOf(l), 0);

  return (
    <Card size="small" title={`清点行（${lines.length} 行 · 差异 ${diffRows.length} 行 · 差异金额 ${fmtMoney(diffSum)}）`}>
      {detail.status === 'CANCELLED' ? (
        <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="该清点单已取消" />
      ) : (
        <Steps
          size="small"
          current={step ?? 0}
          style={{ marginBottom: 12 }}
          items={FLOW_STEPS.map((title) => ({ title }))}
        />
      )}
      <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="实盘时间">{detail.countedAt ? fmtDateTime(detail.countedAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="核对时间">{detail.reconciledAt ? fmtDateTime(detail.reconciledAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="调账时间">{detail.adjustedAt ? fmtDateTime(detail.adjustedAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="超阈值">{detail.thresholdOver ? <Tag color="red">是</Tag> : '否'}</Descriptions.Item>
      </Descriptions>
      <StocktakeLinesTable lines={lines} showDiff />
    </Card>
  );
}

/** 快照行表格（明细/核对弹窗共用）：账面 vs 实盘，盘盈绿盘亏红 */
function StocktakeLinesTable({ lines, showDiff }: { lines: StocktakeLineDTO[]; showDiff: boolean }): JSX.Element {
  return (
    <Table<StocktakeLineDTO>
      size="small"
      rowKey="id"
      pagination={false}
      scroll={{ y: 320 }}
      dataSource={lines}
      locale={{ emptyText: '无快照行' }}
      columns={[
        {
          title: '商品', dataIndex: 'productId',
          render: (_v, l) => (
            <Space size={0} direction="vertical">
              <span>{lineName(l)}</span>
              {lineSkuCode(l) && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{lineSkuCode(l)}</Typography.Text>}
            </Space>
          ),
        },
        { title: '批次', dataIndex: 'batchId', width: 130, render: (_v, l) => lineBatchNo(l) },
        { title: '账面数量', dataIndex: 'systemQty', width: 100, align: 'right' as const, render: (v) => toNum(v) },
        { title: '实盘数量', dataIndex: 'countedQty', width: 100, align: 'right' as const, render: (v) => (showDiff ? toNum(v) : '-') },
        ...(showDiff ? [
          {
            title: '差异数', width: 100, align: 'right' as const,
            render: (_v: unknown, l: StocktakeLineDTO) => {
              const d = diffQtyOf(l);
              return <span style={{ color: diffColor(d) }}>{d.toFixed(3)}</span>;
            },
          },
          {
            title: '差异金额', width: 110, align: 'right' as const,
            render: (_v: unknown, l: StocktakeLineDTO) => {
              const a = diffAmountOf(l);
              return <span style={{ color: diffColor(a) }}>{fmtSigned(a)}</span>;
            },
          },
        ] : []),
        { title: '单位成本', dataIndex: 'unitCost', width: 100, align: 'right' as const, render: (v) => fmtMoney(v) },
      ]}
    />
  );
}

// ───────────────────────── 新建盘点（类型 + 范围；仓管/老板） ─────────────────────────

function CreateStocktakeModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [type, setType] = useState<StocktakeTypeDTO>('SPOT');
  const [scope, setScope] = useState<'ALL' | 'CATEGORY'>('ALL');
  const [category, setCategory] = useState<ProductCategoryDTO>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType('SPOT');
    setScope('ALL');
    setCategory(undefined);
  }, [open]);

  async function submit(): Promise<void> {
    if (scope === 'CATEGORY' && !category) {
      message.warning('请选择清点品类');
      return;
    }
    setSubmitting(true);
    try {
      const res = await stocktakesApi.create({
        type,
        category: scope === 'CATEGORY' ? category : undefined,
      });
      message.success(
        `清点单 ${res.takeNo} 已创建（账面快照 ${res.lines?.length ?? 0} 行），待仓管录实盘`,
      );
      onCreated();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建清点单失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建清点"
      okText="建单（锁账面快照）"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div>
          <Typography.Text type="secondary">清点类型</Typography.Text>
          <Radio.Group
            style={{ marginTop: 4 }}
            value={type}
            onChange={(e: RadioChangeEvent) => setType(e.target.value)}
            options={(Object.keys(STOCKTAKE_TYPE_META) as StocktakeTypeDTO[]).map((value) => ({
              value,
              label: STOCKTAKE_TYPE_META[value].label,
            }))}
            optionType="button"
            buttonStyle="solid"
          />
        </div>
        <div>
          <Typography.Text type="secondary">清点范围</Typography.Text>
          <Space style={{ marginTop: 4 }} wrap>
            <Radio.Group
              value={scope}
              onChange={(e: RadioChangeEvent) => setScope(e.target.value)}
              options={[
                { value: 'ALL', label: '全部商品' },
                { value: 'CATEGORY', label: '按品类' },
              ]}
              optionType="button"
            />
            {scope === 'CATEGORY' && (
              <Select
                style={{ width: 160 }}
                placeholder="选品类"
                value={category}
                onChange={setCategory}
                options={Object.entries(PRODUCT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
              />
            )}
          </Space>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          建单即按当前批次库存生成账面快照行（实盘预填=账面，仓管只改差异行）；账面为零的批次不入盘。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

// ───────────────────────── 录入实盘（仓管，行内编辑 countedQty） ─────────────────────────

interface CountRow {
  id: string;
  label: string;
  skuCode?: string;
  batchNo: string;
  systemQty: number;
  unitCost: number;
  counted: number;
}

function CountStocktakeModal({
  target, onClose, onDone,
}: {
  target: StocktakeDTO | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<CountRow[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!target) return;
    setRows([]);
    setError('');
    stocktakesApi
      .detail(target.id)
      .then((d) => {
        setRows((d.lines ?? []).map((l) => ({
          id: l.id,
          label: lineName(l),
          skuCode: lineSkuCode(l),
          batchNo: lineBatchNo(l),
          systemQty: toNum(l.systemQty),
          unitCost: toNum(l.unitCost),
          counted: toNum(l.countedQty), // 建单预填=账面，只改差异行
        })));
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载快照行失败'));
  }, [target]);

  const diffSum = rows.reduce((s, r) => s + (r.counted - r.systemQty) * r.unitCost, 0);

  /** 全部按账面重置（清掉误改，实盘=账面 → 无差异） */
  function resetBySystem(): void {
    setRows((prev) => prev.map((r) => ({ ...r, counted: r.systemQty })));
  }

  async function submit(): Promise<void> {
    if (!target) return;
    const bad = rows.filter((r) => r.counted === undefined || Number.isNaN(r.counted));
    if (bad.length > 0) {
      message.warning(`尚有 ${bad.length} 行实盘数未填（可点「全部按账面重置」）`);
      return;
    }
    setSubmitting(true);
    try {
      await stocktakesApi.count(target.id, rows.map((r) => ({ id: r.id, countedQty: r.counted })));
      message.success(`实盘已提交（${target.takeNo}），待内勤核对差异`);
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '提交实盘失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={target ? `录入实盘 · ${target.takeNo}` : '录入实盘'}
      okText="提交实盘"
      cancelText="取消"
      width={880}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      {error ? (
        <Alert type="error" message={error} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space wrap>
            <Button size="small" onClick={resetBySystem}>全部按账面重置</Button>
            <Typography.Text type="secondary">
              共 {rows.length} 行 · 当前差异金额{' '}
              <span style={{ color: diffColor(diffSum) }}>{fmtSigned(diffSum)}</span>
            </Typography.Text>
          </Space>
          <Table<CountRow>
            size="small"
            rowKey="id"
            pagination={false}
            scroll={{ y: 380 }}
            dataSource={rows}
            columns={[
              {
                title: '商品', dataIndex: 'label',
                render: (_v, r) => (
                  <Space size={0} direction="vertical">
                    <span>{r.label}</span>
                    {r.skuCode && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.skuCode}</Typography.Text>}
                  </Space>
                ),
              },
              { title: '批次', dataIndex: 'batchNo', width: 130 },
              { title: '账面数量', dataIndex: 'systemQty', width: 100, align: 'right' as const },
              {
                title: '实盘数量', dataIndex: 'counted', width: 140, align: 'right' as const,
                render: (_v, r) => (
                  <InputNumber
                    min={0}
                    step={1}
                    precision={3}
                    size="small"
                    style={{ width: 120 }}
                    value={r.counted}
                    onChange={(v) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, counted: v ?? NaN } : x)))}
                  />
                ),
              },
              {
                title: '差异数', width: 100, align: 'right' as const,
                render: (_v, r) => {
                  if (Number.isNaN(r.counted)) return '-';
                  const d = r.counted - r.systemQty;
                  return <span style={{ color: diffColor(d) }}>{d.toFixed(3)}</span>;
                },
              },
            ]}
          />
        </Space>
      )}
    </Modal>
  );
}

// ───────────────────────── 核对差异（内勤 → RECONCILED / 超阈值送老板） ─────────────────────────

function ReconcileStocktakeModal({
  target, onClose, onDone,
}: {
  target: StocktakeDTO | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [detail, setDetail] = useState<StocktakeDTO | null>(null);
  const [error, setError] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!target) return;
    setDetail(null);
    setError('');
    setOnlyDiff(true);
    stocktakesApi
      .detail(target.id)
      .then((d) => setDetail(d))
      .catch((e) => setError(e instanceof Error ? e.message : '加载明细失败'));
  }, [target]);

  const lines = detail?.lines ?? [];
  const diffRows = lines.filter((l) => Math.abs(diffQtyOf(l)) > 0.0001);
  const gain = diffRows.filter((l) => diffQtyOf(l) > 0).length;
  const loss = diffRows.length - gain;
  const diffSum = diffRows.reduce((s, l) => s + diffAmountOf(l), 0);

  async function submit(): Promise<void> {
    if (!target) return;
    setSubmitting(true);
    try {
      const res = await stocktakesApi.reconcile(target.id);
      if (res.thresholdOver) {
        message.warning('差异金额超阈值，已送老板审批（待审批 · 清点库存调账）：批准后回到「已核对」调账，驳回退回重盘');
      } else {
        message.success('核对完成，差异清单已生成，可执行「调账落账」');
      }
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '核对失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={target ? `核对差异 · ${target.takeNo}` : '核对差异'}
      okText="确认核对"
      cancelText="取消"
      width={960}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      {error ? (
        <Alert type="error" message={error} />
      ) : !detail ? (
        <Card size="small" loading />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert
            type={diffRows.length === 0 ? 'success' : 'warning'}
            showIcon
            message={`共 ${lines.length} 行，差异 ${diffRows.length} 行（盘盈 ${gain} / 盘亏 ${loss}）· 差异金额合计 ${fmtMoney(diffSum)}`}
            description="确认核对后生成差异清单：未超阈值可直接「调账落账」；超阈值自动送老板审批，批准后调账、驳回退回重盘。"
          />
          <Space>
            <Switch size="small" checked={onlyDiff} onChange={setOnlyDiff} />
            <Typography.Text type="secondary">仅看差异行</Typography.Text>
          </Space>
          <StocktakeLinesTable lines={onlyDiff ? diffRows : lines} showDiff />
        </Space>
      )}
    </Modal>
  );
}
