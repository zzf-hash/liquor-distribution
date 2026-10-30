// 订单池（P0-T20~T25）：状态筛选 tab + 行展开明细（含红字冲销行负数）+ 预检结果 + 状态机操作 + 内勤开单
import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert, App as AntApp, Button, Collapse, Descriptions, Input, Space, Spin, Tag, Typography,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Panel, PlainTable } from '../../components/light-ui';
import type { PlainColumn } from '../../components/light-ui';
const ReasonActionModal = lazy(() => import('./order-modals').then((m) => ({ default: m.ReasonActionModal })));
const CreateOrderModal = lazy(() => import('./order-modals').then((m) => ({ default: m.CreateOrderModal })));
import {
  ApiError,
  customersApi,
  downloadApiFile,
  ordersApi,
  pricesApi,
  productsApi,
} from '../../services/api';
import type {
  ApproveSpecialType,
  CustomerDTO,
  OrderDTO,
  OrderLineDTO,
  PriceUnitDTO,
  ProductDTO,
} from '../../services/api';
import { getAuth } from '../../services/auth';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import type { Role } from '../../constants/roles';
import {
  ORDER_STATUS_META,
  ORDER_STATUS_TABS,
  PRICE_TYPE_LABELS,
  PRICE_UNIT_LABELS,
  SIGN_MODE_LABELS,
  SOURCE_LABELS,
  labelOf,
} from '../../constants/labels';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';
import { ReverseLineModal, canReverseLine, netLineQty } from './reverse-line';

type ReasonAction = 'cancel' | 'reject' | 'approveSpecial';

const NEG = '#cf1322'; // 红字冲销/负数

/** 送货单自商家确认起可打印（P0-T24：随出库/配送/签收流转继续可打） */
const PRINTABLE_STATUSES = ['CONFIRMED', 'OUTBOUND', 'DELIVERING', 'SIGNED', 'SETTLED'];

function openDeliveryNote(id: string): void {
  window.open(`/orders/${id}/print`, '_blank');
}

export default function OrdersPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const canOperate = role === 'owner' || role === 'clerk';

  const [activeStatus, setActiveStatus] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<OrderDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [reasonState, setReasonState] = useState<{ type: ReasonAction; order: OrderDTO } | null>(null);

  const reload = (): void => setRefreshKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    ordersApi.list({
      status: activeStatus === 'ALL' ? undefined : activeStatus,
      q: keyword || undefined,
      page,
      pageSize,
    }).then((res) => {
      if (!alive) return;
      setRows(res.items ?? []);
      setTotal(res.total);
    }).catch((e) => {
      if (!alive) return;
      message.error(e instanceof Error ? e.message : '加载订单失败');
      setRows([]);
      setTotal(0);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeStatus, keyword, page, pageSize, refreshKey]);

  const columns: Array<PlainColumn<OrderDTO>> = [
    { title: '订单号', dataIndex: 'orderNo', width: 170, render: (_, r) => <Typography.Text copyable>{r.orderNo}</Typography.Text> },
    { title: '客户', dataIndex: 'customerName', width: 150 },
    {
      title: '来源', dataIndex: 'source', width: 100,
      render: (_, r) => <Tag>{labelOf(SOURCE_LABELS, r.source)}</Tag>,
    },
    {
      title: '签约', dataIndex: 'signMode', width: 80,
      render: (_, r) => <Tag>{labelOf(SIGN_MODE_LABELS, r.signMode)}</Tag>,
    },
    {
      title: '金额', dataIndex: 'totalAmount', width: 120, align: 'right',
      render: (_, r) => (
        <span style={{ color: toNum(r.totalAmount) < 0 ? NEG : undefined }}>{fmtMoney(r.totalAmount)}</span>
      ),
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (_, r) => {
        const meta = ORDER_STATUS_META[r.status];
        return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
      },
    },
    { title: '行数', dataIndex: 'lineCount', width: 70, align: 'right' },
    { title: '下单时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', width: 250,
      render: (_, r) => {
        const btns: ReactNode[] = [];
        if (canOperate) {
          if (r.status === 'PENDING_CONFIRM') {
            btns.push(
              <a key="confirm" onClick={() => confirmOrder(r)}>确认</a>,
              role === 'owner' ? <a key="special" onClick={() => setReasonState({ type: 'approveSpecial', order: r })}>特批</a> : null,
            );
          }
          if (r.status === 'PENDING_CONFIRM' || r.status === 'CONFIRMED') {
            btns.push(<a key="cancel" onClick={() => setReasonState({ type: 'cancel', order: r })}>取消</a>);
          }
          if (r.status === 'OUTBOUND' || r.status === 'DELIVERING') {
            btns.push(<a key="reject" onClick={() => setReasonState({ type: 'reject', order: r })}>拒收</a>);
          }
        }
        if ((role === 'owner' || role === 'clerk' || role === 'warehouse') && r.status === 'CONFIRMED') {
          btns.push(<a key="outbound" onClick={() => { void createOutbound(r); }}>生成拣货单</a>);
        }
        if ((role === 'owner' || role === 'warehouse') && r.status === 'OUTBOUND') {
          btns.push(<a key="deliver" onClick={() => { void deliverOrder(r); }}>发运</a>);
        }
        if (PRINTABLE_STATUSES.includes(r.status)) {
          btns.push(<a key="print" onClick={() => openDeliveryNote(r.id)}>打印送货单</a>);
        }
        return btns.length ? <Space size={4}>{btns}</Space> : '-';
      },
    },
  ];

  async function createOutbound(order: OrderDTO): Promise<void> {
    modal.confirm({
      title: `生成拣货单 ${order.orderNo}？`,
      content: '仅已确认订单可出库。已有有效拣货单时服务端会拒绝。',
      okText: '生成',
      cancelText: '取消',
      onOk: async () => {
        try {
          await ordersApi.outbound(order.id);
          message.success(`已生成拣货单：${order.orderNo}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '生成拣货单失败');
        }
      },
    });
  }

  async function deliverOrder(order: OrderDTO): Promise<void> {
    modal.confirm({
      title: `发运 ${order.orderNo}？`,
      content: '订单将从已出库变为配送中。',
      okText: '发运',
      cancelText: '取消',
      onOk: async () => {
        try {
          await ordersApi.deliver(order.id);
          message.success(`已发运：${order.orderNo}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '发运失败');
        }
      },
    });
  }

  async function confirmOrder(order: OrderDTO): Promise<void> {
    modal.confirm({
      title: `确认订单 ${order.orderNo}？`,
      content: `客户：${order.customerName}，金额 ${fmtMoney(order.totalAmount)}`,
      okText: '确认',
      cancelText: '再想想',
      onOk: async () => {
        try {
          await ordersApi.confirm(order.id);
          message.success(`订单 ${order.orderNo} 已确认`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '确认失败');
        }
      },
    });
  }

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>订单池</Typography.Title>
      <Typography.Paragraph type="secondary">三入口统一订单池（内勤开单/业务员代下/客户商城）</Typography.Paragraph>
      <Panel>
        <Space style={{ marginBottom: 12 }} wrap>
          <select
            value={activeStatus}
            onChange={(e) => { setActiveStatus(e.target.value); setPage(1); reload(); }}
          >
            {ORDER_STATUS_TABS.map((tab) => <option key={String(tab.value)} value={tab.value}>{tab.label}</option>)}
          </select>
          <Input.Search
            style={{ width: 260 }}
            placeholder="订单号 / 客户名"
            allowClear
            onSearch={(v) => { setKeyword(v); setPage(1); reload(); }}
          />
          {canOperate && (
            <Button type="primary" onClick={() => setCreateOpen(true)}>新建订单</Button>
          )}
          {canOperate && (
            <Button
              icon={<DownloadOutlined />}
              onClick={async () => {
                try {
                  const qsParams = new URLSearchParams();
                  if (activeStatus !== 'ALL') qsParams.set('status', activeStatus);
                  if (keyword) qsParams.set('q', keyword);
                  const qsStr = qsParams.toString();
                  await downloadApiFile(`/orders/export${qsStr ? `?${qsStr}` : ''}`, '订单');
                  message.success('订单清单已导出');
                } catch (e) {
                  message.error(e instanceof Error ? e.message : '导出失败');
                }
              }}
            >
              导出 xlsx
            </Button>
          )}
        </Space>
        <PlainTable
          loading={loading}
          dataSource={rows}
          columns={columns}
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          expandable={{ expandedRowRender: (r) => <OrderDetailCard order={r} onChanged={reload} /> }}
        />
      </Panel>

      <Suspense fallback={null}>
        <ReasonActionModal
          state={reasonState}
          onClose={() => setReasonState(null)}
          onDone={() => { setReasonState(null); reload(); }}
        />
        <CreateOrderModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); reload(); }}
        />
      </Suspense>
    </div>
  );
}

// ───────────────────────── 行展开：明细 + 预检 ─────────────────────────

function OrderDetailCard({ order, onChanged }: { order: OrderDTO; onChanged: () => void }): JSX.Element {
  const { message } = AntApp.useApp();
  const role = getAuth()?.role ?? '';
  const [detail, setDetail] = useState<OrderDTO | null>(null);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [reverseTarget, setReverseTarget] = useState<OrderLineDTO | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    ordersApi
      .detail(order.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '加载明细失败'); });
    return () => { alive = false; };
  }, [order.id, reloadTick]);

  if (error) return <Alert type="error" message={error} />;
  if (!detail) return <Spin />;
  const lines = detail.lines ?? [];

  const lineColumns = [
    { title: '商品', dataIndex: 'productName', render: (_: unknown, r: OrderLineDTO) => (
      <Space size={4}>
        <span>{r.productName}</span>
        {r.specText && <Typography.Text type="secondary">{r.specText}</Typography.Text>}
        {r.isGift && <Tag color="purple">赠品</Tag>}
        {r.reversalOfId && <Tag color="error">红字冲销</Tag>}
      </Space>
    ) },
    { title: '单位', dataIndex: 'unit', width: 120, render: (v: string) => labelOf(PRICE_UNIT_LABELS, v) },
    { title: '数量', dataIndex: 'qty', width: 100, align: 'right' as const, render: (v: OrderLineDTO['qty']) => (
      <span style={{ color: toNum(v) < 0 ? NEG : undefined }}>{toNum(v)}</span>
    ) },
    { title: '单价', dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: (v: OrderLineDTO['unitPrice']) => fmtMoney(v) },
    { title: '金额', dataIndex: 'amount', width: 120, align: 'right' as const, render: (v: OrderLineDTO['amount']) => (
      <span style={{ color: toNum(v) < 0 ? NEG : undefined }}>{fmtMoney(v)}</span>
    ) },
    { title: '价格类型', dataIndex: 'priceType', width: 110, render: (v: string) => labelOf(PRICE_TYPE_LABELS, v) },
    {
      title: '操作', width: 80,
      render: (_: unknown, r: OrderLineDTO) => (
        detail && canReverseLine(detail.status, role, lines, r)
          ? <a onClick={() => setReverseTarget(r)}>冲销</a>
          : null
      ),
    },
  ];

  return (
    <Panel
      title={`明细行（${lines.length} 行）`}
      extra={<Button size="small" onClick={() => openDeliveryNote(order.id)}>打印送货单</Button>}
    >
      <PlainTable
        dataSource={lines}
        columns={lineColumns}
        emptyText="无明细行"
      />
      {order.cancelReason && (
        <Alert style={{ marginTop: 12 }} type="warning" message={`取消/拒收原因：${order.cancelReason}`} />
      )}
      {detail.precheck && (
        <Collapse
          style={{ marginTop: 12 }}
          items={[{
            key: 'precheck',
            label: '审单预检结果（四要素：客户有效/信用/价格/库存/起送量）',
            children: (
              <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(detail.precheck, null, 2)}
              </pre>
            ),
          }]}
        />
      )}
      <ReverseLineModal
        open={reverseTarget !== null}
        productName={reverseTarget?.productName ?? ''}
        maxQty={reverseTarget && detail ? netLineQty(lines, reverseTarget) : 0}
        onClose={() => setReverseTarget(null)}
        onSubmit={async (qty, reason) => {
          if (!reverseTarget) return;
          try {
            await ordersApi.reverseLine(order.id, reverseTarget.id, qty, reason);
            message.success('已生成红字冲销行');
            setReverseTarget(null);
            setReloadTick((n) => n + 1);
            onChanged();
          } catch (e) {
            message.error(e instanceof Error ? e.message : '冲销失败');
          }
        }}
      />
    </Panel>
  );
}

