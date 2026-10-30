import { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import {
  ApiError, customersApi, ordersApi, pricesApi, productsApi,
} from '../../services/api';
import type { ApproveSpecialType, CustomerDTO, OrderDTO, PriceUnitDTO, ProductDTO } from '../../services/api';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import { PRICE_TYPE_LABELS, labelOf } from '../../constants/labels';
import { fmtMoney, toNum } from '../../utils/format';

type ReasonAction = 'cancel' | 'reject' | 'approveSpecial';

const APPROVE_TYPE_OPTIONS = [
  { value: 'CREDIT_RELEASE', label: '信用超额放行' },
  { value: 'PRICE_SPECIAL', label: '价格特批' },
  { value: 'ORDER_SPECIAL', label: '特单（地址/时段/宴席/超账期）' },
];

export function ReasonActionModal({
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

export function CreateOrderModal({
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
