// 特单（P1-T02，F8 全员下单+婚宴宴席）：DRAFT→PENDING_PRICE→APPROVED→CONVERTED/REJECTED
// 红线：未经定价审批不可出货——「转正式订单」仅在 APPROVED 可用，其余状态禁用。
import { useEffect, useRef, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  App as AntApp, Button, Card, DatePicker, Descriptions, Input, InputNumber, Modal,
  Select, Space, Switch, Table, Tag, Typography,
} from 'antd';
import { customersApi, productsApi, specialOrdersApi } from '../../services/api';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import type {
  CustomerDTO,
  ProductDTO,
  SpecialOrderDTO,
  SpecialOrderLineDTO,
} from '../../services/api';
import {
  SPECIAL_ORDER_STATUS_META,
  SPECIAL_ORDER_STATUS_TABS,
  labelOf,
} from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, toNum } from '../../utils/format';

/** 特单合计（行金额=数量×单价，后端为准） */
function specialTotal(lines: SpecialOrderLineDTO[] | undefined): number {
  return (lines ?? []).reduce((sum, l) => sum + toNum(l.qty) * toNum(l.price), 0);
}

export default function SpecialOrdersPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [activeStatus, setActiveStatus] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const idemRef = useRef<IdemSlot | null>(null);

  const reload = (): void => setRefreshKey((k) => k + 1);

  /** DRAFT → 提交定价审批（审批中心 PRICE_SPECIAL 线生成待办） */
  function submitForPrice(r: SpecialOrderDTO): void {
    modal.confirm({
      title: `提交定价审批？${r.specialNo}`,
      content: `「${r.title}」提交后进入审批中心（特单价格线），审批通过后方可转正式订单出货。`,
      okText: '提交审批',
      cancelText: '再想想',
      onOk: async () => {
        try {
          await specialOrdersApi.submit(r.id);
          message.success(`已提交定价审批：${r.specialNo}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '提交失败');
        }
      },
    });
  }

  /** APPROVED → 转正式订单（红线闸门：未 APPROVED 服务端拒绝） */
  async function convert(r: SpecialOrderDTO): Promise<void> {
    modal.confirm({
      title: `转正式订单？${r.specialNo}`,
      content: `「${r.title}」将按已审批价格生成正式销售订单，转单后特单状态变为「已转单」。`,
      okText: '转正式订单',
      cancelText: '再想想',
      onOk: async () => {
        try {
          const res = await specialOrdersApi.convert(r.id, rememberIdemKey(idemRef, { convert: r.id }));
          idemRef.current = null;
          message.success(`已转正式订单：${res.orderNo ?? res.convertedOrderId ?? '见订单池'}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '转单失败');
        }
      },
    });
  }

  const columns: ProColumns<SpecialOrderDTO>[] = [
    { title: '特单号', dataIndex: 'specialNo', width: 170, render: (_, r) => <Typography.Text copyable>{r.specialNo}</Typography.Text> },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    { title: '客户', dataIndex: 'customerName', width: 140, render: (_, r) => (
      <Space size={4}>
        <span>{r.customerName}</span>
        {!r.customerId && <Typography.Text type="secondary" style={{ fontSize: 12 }}>散客</Typography.Text>}
      </Space>
    ) },
    { title: '宴席', dataIndex: 'isBanquet', width: 80, render: (_, r) => r.isBanquet ? <Tag color="gold">宴席</Tag> : '-' },
    {
      title: '状态', dataIndex: 'status', width: 110,
      render: (_, r) => {
        const meta = SPECIAL_ORDER_STATUS_META[r.status];
        return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
      },
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', valueType: 'option', width: 220,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'DRAFT' && <a onClick={() => submitForPrice(r)}>提交定价审批</a>}
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={r.status !== 'APPROVED'}
            title={r.status !== 'APPROVED' ? '红线：未经定价审批不可出货' : undefined}
            onClick={() => convert(r)}
          >
            转正式订单
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer title="特单" subTitle="F8 全员下单 · 婚宴宴席用酒 · 未经定价审批不可出货（红线）">
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 140 }}
            value={activeStatus}
            onChange={(v) => { setActiveStatus(v); reload(); }}
            options={SPECIAL_ORDER_STATUS_TABS}
          />
          <Input.Search
            style={{ width: 260 }}
            placeholder="特单号 / 标题 / 客户名"
            allowClear
            onSearch={(v) => { setKeyword(v); reload(); }}
          />
          <Button type="primary" onClick={() => setCreateOpen(true)}>新建特单</Button>
        </Space>
        <ProTable<SpecialOrderDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await specialOrdersApi.list({
                status: activeStatus === 'ALL' ? undefined : activeStatus,
                q: keyword || undefined,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载特单失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          expandable={{ expandedRowRender: (r) => <SpecialOrderDetailCard order={r} /> }}
        />
      </Card>

      <CreateSpecialOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 行展开：特单字段 + 行明细 ─────────────────────────

function SpecialOrderDetailCard({ order }: { order: SpecialOrderDTO }): JSX.Element {
  const [detail, setDetail] = useState<SpecialOrderDTO | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    specialOrdersApi
      .detail(order.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => {
        // 明细接口未就绪时退回列表行数据（行数可能缺失）
        if (alive) setDetail(order);
      });
    return () => { alive = false; };
  }, [order]);

  if (!detail) return <Card size="small" loading />;
  const lines = detail.lines ?? [];

  return (
    <Card size="small" title={`特单详情（${lines.length} 行 · 合计 ${fmtMoney(specialTotal(lines))}）`}>
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="联系人">{detail.contactName}</Descriptions.Item>
        <Descriptions.Item label="联系电话">{detail.contactPhone}</Descriptions.Item>
        <Descriptions.Item label="地址" span={2}>{detail.address}</Descriptions.Item>
        {detail.isBanquet && (
          <>
            <Descriptions.Item label="宴席日期">{fmtDate(detail.eventDate)}</Descriptions.Item>
            <Descriptions.Item label="宴席地点">{detail.venue ?? '-'}</Descriptions.Item>
          </>
        )}
        <Descriptions.Item label="配送时间">{fmtDate(detail.deliveryDate)}</Descriptions.Item>
        <Descriptions.Item label="收款人 / 截止">
          {detail.payeeName ?? '-'}{detail.payDueDate ? ` / ${fmtDate(detail.payDueDate)}` : ''}
        </Descriptions.Item>
        {detail.note && <Descriptions.Item label="备注" span={2}>{detail.note}</Descriptions.Item>}
        {detail.status === 'CONVERTED' && (
          <Descriptions.Item label="正式订单" span={2}>
            <Typography.Text copyable>{detail.orderNo ?? detail.convertedOrderId ?? '-'}</Typography.Text>
          </Descriptions.Item>
        )}
      </Descriptions>
      <Table<SpecialOrderLineDTO>
        size="small"
        style={{ marginTop: 12 }}
        rowKey="id"
        pagination={false}
        dataSource={lines}
        locale={{ emptyText: '无明细行' }}
        columns={[
          { title: '品名', dataIndex: 'productName', render: (_v, r) => (
            <Space size={4}>
              <span>{r.productName}</span>
              {r.specText && <Typography.Text type="secondary">{r.specText}</Typography.Text>}
              {!r.productId && <Tag>自由品名</Tag>}
            </Space>
          ) },
          { title: '单位', dataIndex: 'unit', width: 90 },
          { title: '数量', dataIndex: 'qty', width: 100, align: 'right' as const, render: (v) => toNum(v) },
          { title: '单价', dataIndex: 'price', width: 110, align: 'right' as const, render: (v) => fmtMoney(v) },
          { title: '金额', width: 120, align: 'right' as const, render: (_v, r) => fmtMoney(toNum(r.qty) * toNum(r.price)) },
        ]}
      />
    </Card>
  );
}

// ───────────────────────── 新建特单（F8 字段全集 + 行编辑器） ─────────────────────────

interface SpecialLineDraft {
  key: string;
  productId?: string;
  productName: string;
  unit: string;
  qty?: number;
  price?: number;
}

function newSpecialLine(): SpecialLineDraft {
  return { key: Math.random().toString(36).slice(2), productName: '', unit: '' };
}

function CreateSpecialOrderModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [title, setTitle] = useState('');
  const [customerId, setCustomerId] = useState<string>();
  const [customerName, setCustomerName] = useState('');
  const [isBanquet, setIsBanquet] = useState(false);
  const [eventDate, setEventDate] = useState<string>();
  const [venue, setVenue] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [address, setAddress] = useState('');
  const [deliveryDate, setDeliveryDate] = useState<string>();
  const [payeeName, setPayeeName] = useState('');
  const [payDueDate, setPayDueDate] = useState<string>();
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<SpecialLineDraft[]>([newSpecialLine()]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setCustomerId(undefined);
    setCustomerName('');
    setIsBanquet(false);
    setEventDate(undefined);
    setVenue('');
    setContactName('');
    setContactPhone('');
    setAddress('');
    setDeliveryDate(undefined);
    setPayeeName('');
    setPayDueDate(undefined);
    setNote('');
    setLines([newSpecialLine()]);
    customersApi.list({ page: 1, pageSize: 200, onboarding: 'ACTIVE' })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
    productsApi.list({ page: 1, pageSize: 200, status: 'ON_SALE' })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, [open]);

  function patchLine(key: string, patch: Partial<SpecialLineDraft>): void {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /** 选中档案客户：名称为空时带出；选品：品名/单位为空时带出 */
  function pickCustomer(id: string): void {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (c && !customerName.trim()) setCustomerName(c.name);
  }

  function pickProduct(key: string, productId: string): void {
    const p = products.find((x) => x.id === productId);
    const line = lines.find((l) => l.key === key);
    patchLine(key, {
      productId,
      productName: line && !line.productName.trim() && p ? p.name : line?.productName,
      unit: line && !line.unit.trim() && p ? p.baseUnit : line?.unit,
    });
  }

  const total = lines.reduce((sum, l) => sum + (l.qty ?? 0) * (l.price ?? 0), 0);

  async function submit(): Promise<void> {
    if (!title.trim()) { message.warning('请填写特单标题'); return; }
    if (!customerName.trim()) { message.warning('请填写客户名称（无档案散客直接手填）'); return; }
    if (!contactName.trim() || !contactPhone.trim()) { message.warning('请填写联系人和联系电话'); return; }
    if (!address.trim()) { message.warning('请填写配送地址'); return; }
    if (isBanquet && !eventDate) { message.warning('宴席单请填写宴席日期'); return; }
    const valid = lines.filter((l) => l.productName.trim() && l.qty && l.qty > 0);
    if (valid.length === 0) {
      message.warning('请至少添加一行有效的明细（品名+数量）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await specialOrdersApi.create({
        title: title.trim(),
        customerId: customerId || undefined,
        customerName: customerName.trim(),
        isBanquet,
        eventDate,
        venue: venue.trim() || undefined,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        address: address.trim(),
        deliveryDate,
        payeeName: payeeName.trim() || undefined,
        payDueDate,
        note: note.trim() || undefined,
        lines: valid.map((l) => ({
          productId: l.productId,
          productName: l.productName.trim(),
          unit: l.unit.trim() || '件',
          qty: l.qty as number,
          price: l.price ?? 0,
        })),
      });
      message.success(`特单已创建（草稿）：${res.specialNo}，提交定价审批通过后方可出货`);
      onCreated();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建特单失败');
    } finally {
      setSubmitting(false);
    }
  }

  const dateProps = {
    style: { width: '100%' },
    allowClear: true as const,
  };

  return (
    <Modal
      open={open}
      title="新建特单（F8 全员下单）"
      okText="保存草稿"
      cancelText="取消"
      width={920}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Input style={{ width: 280 }} placeholder="特单标题（如：张府婚宴用酒）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Select
            style={{ width: 240 }}
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="档案客户（散客可不选）"
            value={customerId}
            onChange={(v) => (v ? pickCustomer(v) : setCustomerId(undefined))}
            options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
          />
          <Input style={{ width: 200 }} placeholder="客户名称（必填，可手填）" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        </Space>

        <Space wrap align="center">
          <Space size={4}>
            <Typography.Text>婚宴宴席单</Typography.Text>
            <Switch checked={isBanquet} onChange={setIsBanquet} />
          </Space>
          {isBanquet && (
            <>
              <DatePicker {...dateProps} placeholder="宴席日期" onChange={(d) => setEventDate(d ? d.toISOString() : undefined)} />
              <Input style={{ width: 220 }} placeholder="宴席地点（酒店/场地）" value={venue} onChange={(e) => setVenue(e.target.value)} />
            </>
          )}
        </Space>

        <Space wrap>
          <Input style={{ width: 140 }} placeholder="联系人" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input style={{ width: 150 }} placeholder="联系电话" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          <Input style={{ width: 330 }} placeholder="配送地址" value={address} onChange={(e) => setAddress(e.target.value)} />
          <DatePicker {...dateProps} placeholder="配送时间" onChange={(d) => setDeliveryDate(d ? d.toISOString() : undefined)} />
        </Space>

        <Space wrap>
          <Input style={{ width: 160 }} placeholder="收款人（F8）" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} />
          <DatePicker {...dateProps} placeholder="收款截止时间" onChange={(d) => setPayDueDate(d ? d.toISOString() : undefined)} />
        </Space>

        {lines.map((l) => (
          <Space key={l.key} align="center" wrap>
            <Select
              style={{ minWidth: 220 }}
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder="选商品（自由品名可不选）"
              value={l.productId}
              onChange={(v) => (v ? pickProduct(l.key, v) : patchLine(l.key, { productId: undefined }))}
              options={products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))}
            />
            <Input
              style={{ width: 160 }}
              placeholder="品名（杂酒/赠品组合）"
              value={l.productName}
              onChange={(e) => patchLine(l.key, { productName: e.target.value })}
            />
            <Input
              style={{ width: 90 }}
              placeholder="单位"
              value={l.unit}
              onChange={(e) => patchLine(l.key, { unit: e.target.value })}
            />
            <InputNumber
              min={0.001}
              step={1}
              precision={3}
              style={{ width: 100 }}
              placeholder="数量"
              value={l.qty}
              onChange={(v) => patchLine(l.key, { qty: v ?? undefined })}
            />
            <InputNumber
              min={0}
              precision={2}
              style={{ width: 110 }}
              prefix="¥"
              placeholder="单价"
              value={l.price}
              onChange={(v) => patchLine(l.key, { price: v ?? undefined })}
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
        ))}
        <Space>
          <Button onClick={() => setLines((prev) => [...prev, newSpecialLine()])}>+ 加一行</Button>
          <Typography.Text strong>预估合计：{fmtMoney(total)}</Typography.Text>
        </Space>

        <Input.TextArea
          rows={2}
          maxLength={200}
          showCount
          placeholder="备注（客户要求/赠品说明等）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          保存为草稿后需「提交定价审批」，审批通过（APPROVED）才能转正式订单出货；价格以审批口径为准。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
