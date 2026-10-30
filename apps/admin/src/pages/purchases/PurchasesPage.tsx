// 采购（P1-T06，F3 先付 / F4 后付双流程）：
// F3 先付 DRAFT→PENDING_APPROVAL→APPROVED→PAID→RECEIVED（审批→付款→收货）
// F4 后付 DRAFT→PENDING_APPROVAL→APPROVED→RECEIVED→PAID（审批→收货→付款）
// 收货入库：按(商品,批次)建/补批次 + IN 流水(PURCHASE_IN) + 每行落 COST 成本价版本（D08 版本化）。
// 按钮按类型×状态显隐；新建/提交/付款=老板+内勤，收货=仓配+老板（对齐后端 @Roles）。
import { useEffect, useRef, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, DatePicker, Descriptions, Input, InputNumber,
  Modal, Radio, Select, Space, Steps, Table, Tag, Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import { productsApi, purchasesApi } from '../../services/api';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import type {
  ProductDTO,
  PurchaseLineDTO,
  PurchaseOrderDTO,
  PurchaseTypeDTO,
} from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import {
  PURCHASE_STATUS_META,
  PURCHASE_STATUS_TABS,
  PURCHASE_TYPE_META,
} from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, toNum } from '../../utils/format';

/** 状态流说明（静态口径图）：F3/F4 审批后节点顺序不同 */
const FLOW_STEPS: Record<PurchaseTypeDTO, string[]> = {
  PREPAID: ['草稿', '待审批', '已审批', '登记付款', '收货入库'],
  POSTPAID: ['草稿', '待审批', '已审批', '收货入库', '登记付款'],
};

/** 付款/收货的前置状态（对齐后端 pay/receive 校验） */
function payReady(r: PurchaseOrderDTO): boolean {
  return r.type === 'PREPAID' ? r.status === 'APPROVED' : r.status === 'RECEIVED';
}
function receiveReady(r: PurchaseOrderDTO): boolean {
  return r.type === 'PREPAID' ? r.status === 'PAID' : r.status === 'APPROVED';
}

export default function PurchasesPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const canManage = role === 'owner' || role === 'clerk'; // 新建/提交审批/登记付款
  const canReceiveByRole = role === 'warehouse' || role === 'owner'; // 收货入库
  const [activeStatus, setActiveStatus] = useState('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const idemRef = useRef<IdemSlot | null>(null);

  const reload = (): void => setRefreshKey((k) => k + 1);

  /** DRAFT → 提交 PURCHASE 审批线 */
  function submitForApproval(r: PurchaseOrderDTO): void {
    modal.confirm({
      title: `提交采购审批？${r.purNo}`,
      content: `${PURCHASE_TYPE_META[r.type]?.label ?? r.type} · ${r.supplier} · ${fmtMoney(r.totalAmount)}，提交后进入待审批（采购）。`,
      okText: '提交审批',
      cancelText: '再想想',
      onOk: async () => {
        try {
          await purchasesApi.submit(r.id);
          message.success('已提交审批，请到「待审批」（采购）处理');
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '提交失败');
        }
      },
    });
  }

  /** 登记付款（资金动作，幂等） */
  function pay(r: PurchaseOrderDTO): void {
    modal.confirm({
      title: `登记付款？${r.purNo}`,
      content: `${r.supplier} · 应付 ${fmtMoney(r.totalAmount)}（${PURCHASE_TYPE_META[r.type]?.label ?? r.type}）。付款为资金动作，确认后状态置为「已付款」。`,
      okText: '确认付款',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await purchasesApi.pay(r.id, rememberIdemKey(idemRef, { pay: r.id }));
          idemRef.current = null;
          message.success(`已登记付款 ${fmtMoney(res.amount ?? r.totalAmount)}（${res.purNo}）`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '登记付款失败');
        }
      },
    });
  }

  /** 收货入库（二次确认：批次与成本价版本摘要） */
  function receive(r: PurchaseOrderDTO): void {
    const doReceive = async (): Promise<void> => {
      try {
        const res = await purchasesApi.receive(r.id);
        message.success(
          `收货入库完成（${res.purNo}）：写入 ${res.batches?.length ?? 0} 个批次 IN 流水，落 ${res.costPriceVersions ?? 0} 条成本价版本`,
        );
        reload();
      } catch (e) {
        message.error(e instanceof Error ? e.message : '收货入库失败');
      }
    };
    purchasesApi
      .detail(r.id)
      .then((d) => {
        const lines = d.lines ?? [];
        modal.confirm({
          title: `收货入库？${r.purNo}`,
          content: (
            <div style={{ marginTop: 12 }}>
              <Alert
                type="warning"
                showIcon
                message="执行后不可撤销：按（商品,批次）建/补批次库存、写入 IN 流水（PURCHASE_IN），并为每行落一条 COST 成本价版本（历史版本保留）。"
              />
              <Table<PurchaseLineDTO>
                size="small"
                style={{ marginTop: 12 }}
                rowKey="id"
                pagination={false}
                dataSource={lines}
                columns={[
                  { title: '商品', dataIndex: 'productName', render: (_v, l) => l.product?.name ?? l.productId },
                  { title: '批次号', dataIndex: 'batchNo', width: 130 },
                  { title: '数量(最小单位)', dataIndex: 'qty', width: 120, align: 'right' as const, render: (v) => toNum(v) },
                  { title: '成本单价', dataIndex: 'unitCost', width: 100, align: 'right' as const, render: (v) => fmtMoney(v) },
                ]}
              />
            </div>
          ),
          okText: '确认入库',
          cancelText: '取消',
          onOk: doReceive,
        });
      })
      .catch(() => {
        // 明细拉取失败：降级直接确认（后端 receive 仍按单内行落账）
        modal.confirm({
          title: `收货入库？${r.purNo}`,
          content: '确认后按采购单行写入批次库存与 IN 流水，并落成本价版本。',
          okText: '确认入库',
          cancelText: '取消',
          onOk: doReceive,
        });
      });
  }

  const columns: ProColumns<PurchaseOrderDTO>[] = [
    { title: '采购单号', dataIndex: 'purNo', width: 170, render: (_, r) => <Typography.Text copyable>{r.purNo}</Typography.Text> },
    { title: '供应商', dataIndex: 'supplier', ellipsis: true },
    {
      title: '类型', dataIndex: 'type', width: 100,
      render: (_, r) => {
        const meta = PURCHASE_TYPE_META[r.type];
        return <Tag color={meta?.color}>{meta?.label ?? r.type}</Tag>;
      },
    },
    { title: '金额', dataIndex: 'totalAmount', width: 120, align: 'right', render: (_, r) => fmtMoney(r.totalAmount) },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (_, r) => {
        const meta = PURCHASE_STATUS_META[r.status];
        return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
      },
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', valueType: 'option', width: 200,
      render: (_, r) => (
        <Space size={4}>
          {canManage && r.status === 'DRAFT' && <a onClick={() => submitForApproval(r)}>提交审批</a>}
          {canManage && payReady(r) && <a onClick={() => pay(r)}>登记付款</a>}
          {canReceiveByRole && receiveReady(r) && <a onClick={() => receive(r)}>收货入库</a>}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer title="采购" subTitle="F3 先付（审批→付款→收货） / F4 后付（审批→收货→付款） · 收货落批次与成本价版本">
      <Card size="small" title="状态流说明" style={{ marginBottom: 12 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {(Object.keys(FLOW_STEPS) as PurchaseTypeDTO[]).map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Tag color={PURCHASE_TYPE_META[t].color} style={{ marginInlineEnd: 0 }}>{PURCHASE_TYPE_META[t].label}</Tag>
              <Steps
                size="small"
                current={-1}
                style={{ flex: 1 }}
                items={FLOW_STEPS[t].map((title) => ({ title }))}
              />
            </div>
          ))}
        </Space>
      </Card>

      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 130 }}
            value={activeStatus}
            onChange={(v) => { setActiveStatus(v); reload(); }}
            options={PURCHASE_STATUS_TABS}
          />
          {canManage && <Button type="primary" onClick={() => setCreateOpen(true)}>新建采购单</Button>}
        </Space>
        <ProTable<PurchaseOrderDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await purchasesApi.list({
                status: activeStatus === 'ALL' ? undefined : activeStatus,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载采购单失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          expandable={{ expandedRowRender: (r) => <PurchaseDetailCard record={r} /> }}
        />
      </Card>

      <CreatePurchaseModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 行展开：采购行明细（批次/成本/日期） ─────────────────────────

function PurchaseDetailCard({ record }: { record: PurchaseOrderDTO }): JSX.Element {
  const [detail, setDetail] = useState<PurchaseOrderDTO | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    purchasesApi
      .detail(record.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '加载明细失败'); });
    return () => { alive = false; };
  }, [record]);

  if (error) return <Alert type="error" message={error} />;
  if (!detail) return <Card size="small" loading />;
  const lines = detail.lines ?? [];

  return (
    <Card size="small" title={`采购行（${lines.length} 行 · 合计 ${fmtMoney(detail.totalAmount)}）`}>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="付款时间">{detail.paidAt ? fmtDateTime(detail.paidAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="收货时间">{detail.receivedAt ? fmtDateTime(detail.receivedAt) : '-'}</Descriptions.Item>
        <Descriptions.Item label="收款账户/凭据">{detail.payeeNote ?? '-'}</Descriptions.Item>
        {detail.note && <Descriptions.Item label="备注" span={3}>{detail.note}</Descriptions.Item>}
      </Descriptions>
      <Table<PurchaseLineDTO>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={lines}
        locale={{ emptyText: '无采购行' }}
        columns={[
          {
            title: '商品', dataIndex: 'productId',
            render: (_v, l) => (
              <Space size={0} direction="vertical">
                <span>{l.product?.name ?? l.productId}</span>
                {l.product && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{l.product.skuCode}</Typography.Text>}
              </Space>
            ),
          },
          { title: '批次号', dataIndex: 'batchNo', width: 120 },
          { title: '数量(最小单位)', dataIndex: 'qty', width: 120, align: 'right' as const, render: (v) => toNum(v) },
          { title: '成本单价', dataIndex: 'unitCost', width: 100, align: 'right' as const, render: (v) => fmtMoney(v) },
          { title: '生产日期', dataIndex: 'produceDate', width: 110, render: (v) => fmtDate(v) },
          { title: '到期日', dataIndex: 'expiryDate', width: 110, render: (v) => fmtDate(v) },
          { title: '行金额', width: 110, align: 'right' as const, render: (_v, l) => fmtMoney(toNum(l.qty) * toNum(l.unitCost)) },
        ]}
      />
    </Card>
  );
}

// ───────────────────────── 新建采购单（类型+供应商+行编辑） ─────────────────────────

interface PurchaseLineDraft {
  key: string;
  productId?: string;
  batchNo: string;
  qty?: number;
  unitCost?: number;
  produceDate?: string;
  expiryDate?: string;
}

function newPurchaseLine(): PurchaseLineDraft {
  return { key: Math.random().toString(36).slice(2), batchNo: '' };
}

function CreatePurchaseModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [type, setType] = useState<PurchaseTypeDTO>('PREPAID');
  const [supplier, setSupplier] = useState('');
  const [payeeNote, setPayeeNote] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PurchaseLineDraft[]>([newPurchaseLine()]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType('PREPAID');
    setSupplier('');
    setPayeeNote('');
    setNote('');
    setLines([newPurchaseLine()]);
    productsApi.list({ page: 1, pageSize: 200, status: 'ON_SALE' })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, [open]);

  function patchLine(key: string, patch: Partial<PurchaseLineDraft>): void {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function productOf(id?: string): ProductDTO | undefined {
    return products.find((p) => p.id === id);
  }

  const total = lines.reduce((sum, l) => sum + (l.qty ?? 0) * (l.unitCost ?? 0), 0);

  async function submit(): Promise<void> {
    if (!supplier.trim()) { message.warning('请填写供应商'); return; }
    const valid = lines.filter((l) => l.productId && l.batchNo.trim() && l.qty && l.qty > 0 && l.unitCost !== undefined);
    if (valid.length === 0) {
      message.warning('请至少添加一行有效的采购明细（商品+批次号+数量+成本单价）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await purchasesApi.create({
        supplier: supplier.trim(),
        type,
        payeeNote: payeeNote.trim() || undefined,
        note: note.trim() || undefined,
        lines: valid.map((l) => ({
          productId: l.productId as string,
          batchNo: l.batchNo.trim(),
          qty: l.qty as number,
          unitCost: l.unitCost as number,
          produceDate: l.produceDate,
          expiryDate: l.expiryDate,
        })),
      });
      message.success(`采购单已创建（草稿）：${res.purNo}，提交审批通过后方可付款/收货`);
      onCreated();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建采购单失败');
    } finally {
      setSubmitting(false);
    }
  }

  const dateProps = {
    style: { width: 140 },
    allowClear: true as const,
  };

  return (
    <Modal
      open={open}
      title="新建采购单"
      okText="保存草稿"
      cancelText="取消"
      width={1040}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Radio.Group
            value={type}
            onChange={(e: RadioChangeEvent) => setType(e.target.value)}
            options={[
              { value: 'PREPAID', label: '先付 F3（审批→付款→收货）' },
              { value: 'POSTPAID', label: '后付 F4（审批→收货→付款）' },
            ]}
            optionType="button"
            buttonStyle="solid"
          />
          <Input style={{ width: 220 }} placeholder="供应商（必填）" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <Input style={{ width: 220 }} placeholder="收款账户/凭据（选填）" value={payeeNote} onChange={(e) => setPayeeNote(e.target.value)} />
        </Space>

        {lines.map((l) => {
          const p = productOf(l.productId);
          return (
            <Space key={l.key} align="center" wrap>
              <Select
                style={{ minWidth: 220 }}
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="选商品"
                value={l.productId}
                onChange={(v) => patchLine(l.key, { productId: v })}
                options={products.map((x) => ({ value: x.id, label: `${x.name}（${x.skuCode}）` }))}
              />
              <Input
                style={{ width: 130 }}
                placeholder="批次号（必填）"
                value={l.batchNo}
                onChange={(e) => patchLine(l.key, { batchNo: e.target.value })}
              />
              <InputNumber
                min={0.001}
                step={1}
                precision={3}
                style={{ width: 120 }}
                placeholder={`数量(${p?.minUnit ?? '最小单位'})`}
                value={l.qty}
                onChange={(v) => patchLine(l.key, { qty: v ?? undefined })}
              />
              <InputNumber
                min={0}
                precision={4}
                style={{ width: 120 }}
                prefix="¥"
                placeholder="成本单价"
                value={l.unitCost}
                onChange={(v) => patchLine(l.key, { unitCost: v ?? undefined })}
              />
              <DatePicker
                {...dateProps}
                placeholder="生产日期"
                onChange={(d) => patchLine(l.key, { produceDate: d ? d.format('YYYY-MM-DD') : undefined })}
              />
              <DatePicker
                {...dateProps}
                placeholder="到期日"
                onChange={(d) => patchLine(l.key, { expiryDate: d ? d.format('YYYY-MM-DD') : undefined })}
              />
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
          <Button onClick={() => setLines((prev) => [...prev, newPurchaseLine()])}>+ 加一行</Button>
          <Typography.Text strong>预估合计：{fmtMoney(total)}</Typography.Text>
        </Space>

        <Input.TextArea
          rows={2}
          maxLength={200}
          showCount
          placeholder="备注（选填）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          保存为草稿后需「提交审批」（采购线）；收货入库时按行落批次库存与 COST 成本价版本，已过期批次后端拒入。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
