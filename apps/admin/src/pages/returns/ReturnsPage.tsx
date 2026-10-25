// 退货（P1-T03，F10 全流程）：关联原单（必填）→ 勾行定数（上限=行净数量，红字已扣减）
// → 待审批（RETURN 线）→ APPROVED 后仓库收货确认（批次回冲+应收冲减二次确认）。
// R4「数量只能多不少」：待审批单可追加行，已审批后不可再加。
import { useEffect, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Descriptions, Input, InputNumber, Modal,
  Select, Space, Spin, Steps, Table, Tag, Typography,
} from 'antd';
import { customersApi, ordersApi, returnsApi } from '../../services/api';
import type {
  CustomerDTO,
  OrderDTO,
  OrderLineDTO,
  ReturnOrderDTO,
} from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import { RETURN_STATUS_META, RETURN_STATUS_TABS } from '../../constants/labels';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';
import { decidePreviewFailure } from './preview-receive';

/** 原订单行净数量：原行数量 + 其红字冲销行（负数）——退货上限 */
function netQtyMap(lines: OrderLineDTO[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!l.reversalOfId) m.set(l.id, toNum(l.qty));
  }
  for (const l of lines) {
    if (l.reversalOfId) m.set(l.reversalOfId, (m.get(l.reversalOfId) ?? 0) + toNum(l.qty));
  }
  return m;
}

export default function ReturnsPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  // 收货确认=仓库视角（老板可代收）
  const canReceive = role === 'warehouse' || role === 'owner';

  const [activeStatus, setActiveStatus] = useState('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = (): void => setRefreshKey((k) => k + 1);

  /** APPROVED → 仓库收货确认。先展示预览；409 及其他错误停住，只有预览接口 404 才降级确认。 */
  function receiveReturn(r: ReturnOrderDTO): void {
    const doReceive = async (): Promise<void> => {
      try {
        const res = await returnsApi.receive(r.id);
        message.success(`收货完成，批次已回冲、应收已重算：${res.returnNo ?? r.returnNo}`);
        reload();
      } catch (e) {
        message.error(e instanceof Error ? e.message : '收货确认失败');
      }
    };
    returnsApi
      .previewReceive(r.id)
      .then((p) => {
        modal.confirm({
          title: `收货确认？${r.returnNo}`,
          content: (
            <div style={{ marginTop: 12 }}>
              <Alert
                type="warning"
                showIcon
                message="执行后不可撤销：按下列批次回冲库存，并冲减对应应收"
              />
              <Table
                size="small"
                style={{ marginTop: 12 }}
                rowKey={(b) => `${b.batchNo}-${b.productId}`}
                pagination={false}
                dataSource={p.batches}
                columns={[
                  { title: '批次', dataIndex: 'batchNo', render: (v) => v ?? '-' },
                  { title: '商品', dataIndex: 'productName', render: (v, b) => v ?? b.productId },
                  { title: '回冲数量', dataIndex: 'qty', width: 110, align: 'right' as const, render: (v) => toNum(v) },
                ]}
              />
              <Descriptions size="small" column={1} bordered style={{ marginTop: 12 }}>
                <Descriptions.Item label="应收冲减">
                  <span style={{ color: '#cf1322', fontWeight: 600 }}>{fmtMoney(p.arCredit)}</span>
                </Descriptions.Item>
              </Descriptions>
            </div>
          ),
          okText: '确认收货',
          cancelText: '取消',
          onOk: doReceive,
        });
      })
      .catch((error: unknown) => {
        const decision = decidePreviewFailure(error);
        if (decision.kind === 'stop') {
          message.error(decision.message);
          return;
        }
        modal.confirm({
          title: `收货确认？${r.returnNo}`,
          content: decision.message,
          okText: '确认收货',
          cancelText: '取消',
          onOk: doReceive,
        });
      });
  }

  const columns: ProColumns<ReturnOrderDTO>[] = [
    { title: '退货单号', dataIndex: 'returnNo', width: 170, render: (_, r) => <Typography.Text copyable>{r.returnNo}</Typography.Text> },
    { title: '原订单', dataIndex: 'orderNo', width: 160, render: (_, r) => (
      <Space size={4}>
        <Typography.Text copyable>{r.orderNo ?? r.sourceOrderId}</Typography.Text>
      </Space>
    ) },
    { title: '客户', dataIndex: 'customerName', width: 140, render: (_, r) => r.customerName ?? r.customerId },
    { title: '行数', dataIndex: 'lineCount', width: 70, align: 'right', render: (_, r) => r.lineCount ?? '-' },
    { title: '退货数量', dataIndex: 'qtySum', width: 100, align: 'right', render: (_, r) => r.qtySum === undefined || r.qtySum === null ? '-' : toNum(r.qtySum) },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (_, r) => {
        const meta = RETURN_STATUS_META[r.status];
        return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
      },
    },
    { title: '退货原因', dataIndex: 'reason', ellipsis: true },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', valueType: 'option', width: 110,
      render: (_, r) => canReceive && r.status === 'APPROVED'
        ? <a onClick={() => receiveReturn(r)}>收货确认</a>
        : '-',
    },
  ];

  return (
    <PageContainer title="退货" subTitle="F10 全流程 · 必须关联原单 · R4 数量只能多不能少 · 收货后应收自动重算">
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 130 }}
            value={activeStatus}
            onChange={(v) => { setActiveStatus(v); reload(); }}
            options={RETURN_STATUS_TABS}
          />
          <Button type="primary" onClick={() => setCreateOpen(true)}>新建退货</Button>
        </Space>
        <ProTable<ReturnOrderDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await returnsApi.list({
                status: activeStatus === 'ALL' ? undefined : activeStatus,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载退货单失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          expandable={{
            expandedRowRender: (r) => (
              <ReturnDetailCard
                record={r}
                canAppend={role === 'owner' || role === 'clerk'}
                onChanged={reload}
              />
            ),
          }}
        />
      </Card>

      <CreateReturnModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 行展开：退货行明细 ─────────────────────────

function ReturnDetailCard({
  record, canAppend, onChanged,
}: {
  record: ReturnOrderDTO;
  canAppend: boolean;
  onChanged: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [detail, setDetail] = useState<ReturnOrderDTO | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [appendOpen, setAppendOpen] = useState(false);
  const [orderDetail, setOrderDetail] = useState<OrderDTO | null>(null);
  const [appendLineId, setAppendLineId] = useState<string>();
  const [appendQty, setAppendQty] = useState<number | null>(null);
  const [appending, setAppending] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    returnsApi
      .detail(record.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '加载明细失败'); });
    return () => { alive = false; };
  }, [record, tick]);

  useEffect(() => {
    if (!appendOpen) return;
    setOrderDetail(null);
    setAppendLineId(undefined);
    setAppendQty(null);
    ordersApi.detail(record.sourceOrderId)
      .then(setOrderDetail)
      .catch(() => setOrderDetail(null));
  }, [appendOpen, record.sourceOrderId]);

  if (error) return <Alert type="error" message={error} />;
  if (!detail) return <Spin />;
  const lines = detail.lines ?? [];

  const showAppend = canAppend && (detail.status === 'PENDING_REVIEW' || record.status === 'PENDING_REVIEW');
  const orderLines = (orderDetail?.lines ?? []).filter((l) => !l.reversalOfId);
  const nets = orderDetail?.lines ? netQtyMap(orderDetail.lines) : new Map<string, number>();

  async function submitAppend(): Promise<void> {
    if (!appendLineId || !appendQty || appendQty <= 0) {
      message.warning('请选择原订单行并填写追加数量');
      return;
    }
    setAppending(true);
    try {
      await returnsApi.appendLines(record.id, [{ orderLineId: appendLineId, qty: appendQty }]);
      message.success('已追加退货行');
      setAppendOpen(false);
      setTick((n) => n + 1);
      onChanged();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '追加失败');
    } finally {
      setAppending(false);
    }
  }

  return (
    <Card
      size="small"
      title={`退货行（${lines.length} 行）`}
      extra={showAppend ? <Button size="small" onClick={() => setAppendOpen(true)}>追加退货行</Button> : null}
    >
      <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="退货原因" span={2}>{detail.reason}</Descriptions.Item>
        <Descriptions.Item label="收货时间">{detail.receivedAt ? fmtDateTime(detail.receivedAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="客户">{detail.customerName ?? detail.customerId}</Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={lines}
        locale={{ emptyText: '无退货行' }}
        columns={[
          { title: '商品', dataIndex: 'productName', render: (v, r) => v ?? r.productId },
          { title: '退货数量', dataIndex: 'qty', width: 110, align: 'right' as const, render: (v) => toNum(v) },
          { title: '备注', dataIndex: 'note', render: (v) => v ?? '-' },
        ]}
      />
      <Modal
        open={appendOpen}
        title="追加退货行"
        okText="追加"
        cancelText="取消"
        confirmLoading={appending}
        onOk={() => { void submitAppend(); }}
        onCancel={() => setAppendOpen(false)}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          仅待审批的退货单可追加。数量只能增加，累计不能超过签收实收。
        </Typography.Paragraph>
        <Select
          style={{ width: '100%', marginBottom: 12 }}
          placeholder={orderDetail ? '选择原订单行' : '正在加载原订单…'}
          value={appendLineId}
          onChange={setAppendLineId}
          options={orderLines.map((l) => ({
            value: l.id,
            label: `${l.productName}（净量 ${nets.get(l.id) ?? toNum(l.qty)}）`,
          }))}
        />
        <InputNumber
          style={{ width: '100%' }}
          min={0.001}
          value={appendQty ?? undefined}
          placeholder="追加数量"
          onChange={(v) => setAppendQty(typeof v === 'number' ? v : null)}
        />
      </Modal>
    </Card>
  );
}

// ───────────────────────── 新建退货（三步：选客户 → 选原单勾行 → 原因确认） ─────────────────────────

function CreateReturnModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [step, setStep] = useState(0);
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [customerId, setCustomerId] = useState<string>();
  const [signedOrders, setSignedOrders] = useState<OrderDTO[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderId, setOrderId] = useState<string>();
  const [orderDetail, setOrderDetail] = useState<OrderDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [qtyByLine, setQtyByLine] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 开启即复位 + 拉客户
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setCustomerId(undefined);
    setSignedOrders([]);
    setOrderId(undefined);
    setOrderDetail(null);
    setDetailError('');
    setSelectedLineIds([]);
    setQtyByLine({});
    setReason('');
    customersApi.list({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
  }, [open]);

  // 选定客户 → 拉该客户已签收订单（D13：退货必须关联原单）
  useEffect(() => {
    if (!customerId) return;
    let alive = true;
    setOrdersLoading(true);
    setOrderId(undefined);
    setOrderDetail(null);
    ordersApi
      .list({ customerId, status: 'SIGNED', page: 1, pageSize: 50 })
      .then((r) => { if (alive) setSignedOrders(r.items); })
      .catch((e) => {
        if (alive) {
          setSignedOrders([]);
          message.error(e instanceof Error ? e.message : '加载已签收订单失败');
        }
      })
      .finally(() => { if (alive) setOrdersLoading(false); });
    return () => { alive = false; };
  }, [customerId, message]);

  // 选定原单 → 拉明细行（含红字冲销行，用于计算净数量上限）
  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    setDetailLoading(true);
    setDetailError('');
    setSelectedLineIds([]);
    setQtyByLine({});
    ordersApi
      .detail(orderId)
      .then((d) => { if (alive) setOrderDetail(d); })
      .catch((e) => { if (alive) setDetailError(e instanceof Error ? e.message : '加载订单明细失败'); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [orderId]);

  const originalLines = (orderDetail?.lines ?? []).filter((l) => !l.reversalOfId);
  const netMap = netQtyMap(orderDetail?.lines ?? []);
  const selectedQty = selectedLineIds.reduce((s, id) => s + (qtyByLine[id] ?? 0), 0);

  function next(): void {
    if (step === 0 && !customerId) {
      message.warning('请选择退货客户');
      return;
    }
    if (step === 1) {
      if (!orderId) {
        message.warning('请选择原订单（仅已签收订单可退货）');
        return;
      }
      const valid = selectedLineIds.filter((id) => (qtyByLine[id] ?? 0) > 0);
      if (valid.length === 0) {
        message.warning('请勾选至少一行退货商品并填写数量');
        return;
      }
    }
    setStep((s) => Math.min(s + 1, 2));
  }

  async function submit(): Promise<void> {
    if (!orderId || !orderDetail) return;
    if (!reason.trim()) {
      message.warning('请填写退货原因（必填）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await returnsApi.create({
        sourceOrderId: orderId,
        reason: reason.trim(),
        lines: selectedLineIds
          .filter((id) => (qtyByLine[id] ?? 0) > 0)
          .map((id) => ({ orderLineId: id, qty: qtyByLine[id] })),
      });
      message.success(`退货单已创建：${res.returnNo ?? ''}，已进入审批中心（退货线）待审批`);
      onCreated();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建退货失败');
    } finally {
      setSubmitting(false);
    }
  }

  const lineColumns = [
    {
      title: '商品', dataIndex: 'productName',
      render: (v: string, r: OrderLineDTO) => (
        <Space size={4}>
          <span>{v}</span>
          {r.isGift && <Tag color="purple">赠品</Tag>}
        </Space>
      ),
    },
    { title: '单位', dataIndex: 'unit', width: 100 },
    { title: '原数量', width: 90, align: 'right' as const, render: (_v: unknown, r: OrderLineDTO) => toNum(r.qty) },
    {
      title: '可退上限（净数量）', width: 130, align: 'right' as const,
      render: (_v: unknown, r: OrderLineDTO) => netMap.get(r.id) ?? 0,
    },
    {
      title: '退货数量', width: 140,
      render: (_v: unknown, r: OrderLineDTO) => {
        const max = netMap.get(r.id) ?? 0;
        return (
          <InputNumber
            min={0.001}
            max={max}
            precision={3}
            step={1}
            style={{ width: 120 }}
            disabled={!selectedLineIds.includes(r.id) || max <= 0}
            value={qtyByLine[r.id]}
            onChange={(v) => setQtyByLine((prev) => ({ ...prev, [r.id]: v ?? 0 }))}
          />
        );
      },
    },
  ];

  const footer = [
    <Button key="cancel" onClick={onClose}>取消</Button>,
    step > 0 ? <Button key="prev" onClick={() => setStep((s) => s - 1)}>上一步</Button> : null,
    step < 2 ? (
      <Button key="next" type="primary" onClick={next}>下一步</Button>
    ) : (
      <Button key="submit" type="primary" loading={submitting} onClick={submit}>提交退货</Button>
    ),
  ];

  return (
    <Modal
      open={open}
      title="新建退货（关联原单）"
      width={860}
      footer={footer}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Steps
          size="small"
          current={step}
          items={[{ title: '选客户' }, { title: '选原订单 · 勾退货行' }, { title: '退货原因' }]}
        />

        {step === 0 && (
          <Select
            style={{ width: 360 }}
            showSearch
            optionFilterProp="label"
            placeholder="选择退货客户"
            value={customerId}
            onChange={setCustomerId}
            options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
          />
        )}

        {step === 1 && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Select
              style={{ width: 480 }}
              loading={ordersLoading}
              placeholder={customerId ? '选择该客户已签收订单' : '请先返回选择客户'}
              disabled={!customerId}
              value={orderId}
              onChange={setOrderId}
              options={signedOrders.map((o) => ({
                value: o.id,
                label: `${o.orderNo} · ${fmtDateTime(o.createdAt)} · ${fmtMoney(o.totalAmount)}`,
              }))}
            />
            {detailError && <Alert type="error" message={detailError} />}
            {detailLoading && <Spin />}
            {orderDetail && (
              <Table<OrderLineDTO>
                size="small"
                rowKey="id"
                pagination={false}
                columns={lineColumns}
                dataSource={originalLines}
                locale={{ emptyText: '该订单无可退商品行' }}
                rowSelection={{
                  selectedRowKeys: selectedLineIds,
                  onChange: (keys) => {
                    setSelectedLineIds(keys as string[]);
                    // 勾选即默认整行可退上限（净数量），可下调至本次实退数
                    setQtyByLine((prev) => {
                      const nextMap = { ...prev };
                      for (const k of keys as string[]) {
                        if (nextMap[k] === undefined) nextMap[k] = netMap.get(k) ?? 0;
                      }
                      return nextMap;
                    });
                  },
                  getCheckboxProps: (r) => ({ disabled: (netMap.get(r.id) ?? 0) <= 0 }),
                }}
              />
            )}
            <Alert
              type="info"
              showIcon
              message="R4「数量只能多不能少」：提交后退货行数量不可改小，需补退走追加退货；上限=原订单行净数量（红字冲销已扣减）。"
            />
          </Space>
        )}

        {step === 2 && orderDetail && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="客户">
                {orderDetail.customerName}
              </Descriptions.Item>
              <Descriptions.Item label="原订单">{orderDetail.orderNo}</Descriptions.Item>
              <Descriptions.Item label="退货行数">{selectedLineIds.length} 行</Descriptions.Item>
              <Descriptions.Item label="退货数量合计">{selectedQty}</Descriptions.Item>
            </Descriptions>
            <Input.TextArea
              rows={3}
              maxLength={200}
              showCount
              placeholder="退货原因（必填，如：破损/临期/客户拒收部分）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              提交后进入审批中心（退货线）审批；审批通过后由仓库「收货确认」回冲批次并自动冲减应收。
            </Typography.Text>
          </Space>
        )}
      </Space>
    </Modal>
  );
}
