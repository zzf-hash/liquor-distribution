// 订单池（P0-T20~T25）：状态筛选 tab + 行展开明细（含红字冲销行负数）+ 预检结果 + 状态机操作 + 内勤开单
import { useEffect, useRef, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Collapse, Descriptions, Input, InputNumber, Modal,
  Select, Space, Spin, Table, Tag, Typography,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
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
import type { ReactNode } from 'react';
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
  const [createOpen, setCreateOpen] = useState(false);
  const [reasonState, setReasonState] = useState<{ type: ReasonAction; order: OrderDTO } | null>(null);

  const reload = (): void => setRefreshKey((k) => k + 1);

  const columns: ProColumns<OrderDTO>[] = [
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
      title: '操作', valueType: 'option', width: 250,
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
        if (PRINTABLE_STATUSES.includes(r.status)) {
          btns.push(<a key="print" onClick={() => openDeliveryNote(r.id)}>打印送货单</a>);
        }
        return btns.length ? <Space size={4}>{btns}</Space> : '-';
      },
    },
  ];

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
    <PageContainer title="订单池" subTitle="三入口统一订单池（内勤开单/业务员代下/客户商城）">
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 130 }}
            value={activeStatus}
            onChange={(v) => { setActiveStatus(v); reload(); }}
            options={ORDER_STATUS_TABS}
          />
          <Input.Search
            style={{ width: 260 }}
            placeholder="订单号 / 客户名"
            allowClear
            onSearch={(v) => { setKeyword(v); reload(); }}
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
        <ProTable<OrderDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await ordersApi.list({
                status: activeStatus === 'ALL' ? undefined : activeStatus,
                q: keyword || undefined,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载订单失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          expandable={{ expandedRowRender: (r) => <OrderDetailCard order={r} onChanged={reload} /> }}
        />
      </Card>

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
    </PageContainer>
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
    <Card
      size="small"
      title={`明细行（${lines.length} 行）`}
      extra={<Button size="small" onClick={() => openDeliveryNote(order.id)}>打印送货单</Button>}
    >
      <Table<OrderLineDTO>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={lines}
        columns={lineColumns}
        locale={{ emptyText: '无明细行' }}
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
    </Card>
  );
}

// ───────────────────────── 取消/拒收/特批（需填原因） ─────────────────────────

const APPROVE_TYPE_OPTIONS = [
  { value: 'CREDIT_RELEASE', label: '信用超额放行' },
  { value: 'PRICE_SPECIAL', label: '价格特批' },
  { value: 'ORDER_SPECIAL', label: '特单（地址/时段/宴席/超账期）' },
];

function ReasonActionModal({
  state, onClose, onDone,
}: {
  state: { type: ReasonAction; order: OrderDTO } | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [reason, setReason] = useState('');
  const [approveType, setApproveType] = useState<ApproveSpecialType>('ORDER_SPECIAL');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state) { setReason(''); setApproveType('ORDER_SPECIAL'); }
  }, [state]);

  const META: Record<ReasonAction, { title: string; placeholder: string; okText: string }> = {
    cancel: { title: '取消订单（需填写原因）', placeholder: '请输入取消原因（审计留痕）', okText: '取消订单' },
    reject: { title: '拒收登记（需填写原因）', placeholder: '请输入拒收原因（库存与订单状态将回滚）', okText: '确认拒收' },
    approveSpecial: { title: '特批放行（需填写理由）', placeholder: '请输入特批理由（审计留痕，仅老板可特批）', okText: '特批放行' },
  };

  async function submit(): Promise<void> {
    if (!state) return;
    if (!reason.trim()) {
      message.warning('请填写原因/理由');
      return;
    }
    setSubmitting(true);
    try {
      const { type, order } = state;
      if (type === 'cancel') await ordersApi.cancel(order.id, reason.trim());
      else if (type === 'reject') await ordersApi.reject(order.id, reason.trim());
      else await ordersApi.approveSpecial(order.id, approveType, reason.trim());
      message.success(`${META[state.type].okText}成功：${order.orderNo}`);
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={state !== null}
      title={state ? META[state.type].title : ''}
      okText={state ? META[state.type].okText : '确定'}
      cancelText="关闭"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      {state?.type === 'approveSpecial' && (
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="订单">{state.order.orderNo}（{state.order.customerName}）</Descriptions.Item>
        </Descriptions>
      )}
      {state?.type === 'approveSpecial' && (
        <Select
          style={{ width: '100%', marginBottom: 12 }}
          value={approveType}
          onChange={(v) => setApproveType(v as ApproveSpecialType)}
          options={APPROVE_TYPE_OPTIONS}
        />
      )}
      <Input.TextArea
        rows={3}
        maxLength={200}
        showCount
        placeholder={state ? META[state.type].placeholder : ''}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}

// ───────────────────────── 新建订单（内勤开单） ─────────────────────────

interface LineDraft {
  key: string;
  productId?: string;
  unit: PriceUnitDTO;
  qty?: number;
  price?: { price: string | number; priceType: string } | null;
}

function newLine(): LineDraft {
  return { key: Math.random().toString(36).slice(2), unit: 'BASE' };
}

function CreateOrderModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const idemRef = useRef<IdemSlot | null>(null);
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [customerId, setCustomerId] = useState<string>();
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [precheckError, setPrecheckError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    idemRef.current = null;
    setLines([newLine()]);
    setCustomerId(undefined);
    setPrecheckError(null);
    customersApi.list({ page: 1, pageSize: 200, onboarding: 'ACTIVE' })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
    productsApi.list({ page: 1, pageSize: 200, status: 'ON_SALE' })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, [open]);

  const productOptions = products.map((p) => ({
    value: p.id,
    label: `${p.name}（${p.skuCode}）`,
  }));

  function patchLine(key: string, patch: Partial<LineDraft>): void {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /** 选品/换单位后自动取价（客户专属价>终端>二批>一批>零售） */
  function resolvePriceOf(line: LineDraft): void {
    if (!customerId || !line.productId) return;
    const pid = line.productId;
    const unit = line.unit;
    pricesApi
      .resolve({ customerId, productId: pid, unit })
      .then((r) => patchLine(line.key, { price: { price: r.price, priceType: r.priceType } }))
      .catch(() => patchLine(line.key, { price: null }));
  }

  const total = lines.reduce(
    (sum, l) => sum + (l.price ? toNum(l.price.price) * (l.qty ?? 0) : 0),
    0,
  );

  async function submit(): Promise<void> {
    if (!customerId) {
      message.warning('请选择客户');
      return;
    }
    const valid = lines.filter((l) => l.productId && l.qty && l.qty > 0);
    if (valid.length === 0) {
      message.warning('请至少添加一行有效的商品明细（商品+数量）');
      return;
    }
    setSubmitting(true);
    setPrecheckError(null);
    const payload = {
      customerId,
      source: 'CLERK' as const,
      lines: valid.map((l) => ({ productId: l.productId as string, unit: l.unit, qty: l.qty as number })),
    };
    try {
      const res = await ordersApi.create(payload, rememberIdemKey(idemRef, payload));
      idemRef.current = null;
      message.success(`下单成功：${res.orderNo}（${fmtMoney(res.totalAmount)}）`);
      onCreated();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.body?.data) {
        // 审单预检拦截：展示四要素结果供修正或走特批
        setPrecheckError(`${e.message}\n${JSON.stringify(e.body.data, null, 2)}`);
      } else {
        message.error(e instanceof Error ? e.message : '下单失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建订单（内勤开单）"
      okText="提交订单"
      cancelText="取消"
      width={860}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Select
          style={{ width: 360 }}
          showSearch
          optionFilterProp="label"
          placeholder="选择客户（仅开户生效客户可下单）"
          value={customerId}
          onChange={setCustomerId}
          options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
        />
        {lines.map((l) => {
          const product = products.find((p) => p.id === l.productId);
          return (
            <Space key={l.key} align="center" wrap>
              <Select
                style={{ minWidth: 240 }}
                showSearch
                optionFilterProp="label"
                placeholder="选择商品"
                value={l.productId}
                onChange={(v) => {
                  patchLine(l.key, { productId: v, price: null });
                  resolvePriceOf({ ...l, productId: v });
                }}
                options={productOptions}
              />
              <Select
                style={{ width: 150 }}
                value={l.unit}
                onChange={(v) => {
                  patchLine(l.key, { unit: v, price: null });
                  resolvePriceOf({ ...l, unit: v });
                }}
                options={[
                  { value: 'BASE', label: `整（${product?.baseUnit ?? '箱'}）` },
                  { value: 'MIN', label: `散（${product?.minUnit ?? '瓶'}）` },
                ]}
              />
              <InputNumber
                min={0.001}
                step={1}
                precision={3}
                style={{ width: 110 }}
                placeholder="数量"
                value={l.qty}
                onChange={(v) => patchLine(l.key, { qty: v ?? undefined })}
              />
              {l.price ? (
                <Typography.Text>
                  {fmtMoney(l.price.price)}
                  <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                    {labelOf(PRICE_TYPE_LABELS, l.price.priceType)}
                  </Typography.Text>
                </Typography.Text>
              ) : (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  {l.productId ? '无生效价' : ''}
                </Typography.Text>
              )}
              <Button
                type="text"
                danger
                disabled={lines.length === 1}
                onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
              >
                删除
              </Button>
            </Space>
          );
        })}
        <Space>
          <Button onClick={() => setLines((prev) => [...prev, newLine()])}>+ 加一行</Button>
          <Typography.Text strong>预估合计：{fmtMoney(total)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            成交价以服务端取价与计算为准
          </Typography.Text>
        </Space>
        {precheckError && (
          <Alert
            type="error"
            message="审单预检未通过（四要素）"
            description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{precheckError}</pre>}
          />
        )}
      </Space>
    </Modal>
  );
}
