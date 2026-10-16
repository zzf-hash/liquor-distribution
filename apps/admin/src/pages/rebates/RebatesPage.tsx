// 优惠返利（P1-T08，D02 优惠三式 b/c + C组坎级/现金/随单赠）：
// b 除瓶箱后 1%-50% 月末核算（可选坎级阶梯：月累计基数取最高命中档）/ c 定扣货款；
// 同客户同一时刻仅一个生效方案（后端 409 互斥，前端捕获展示）；
// 月末核算：GOODS=货补走随单赠下单 / INVOICE=票折冲应收 / CASH=现金(生成返利费用单付款)；
// 随单赠：买N送M 规则，下单管线自动追加 0 价赠品行。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { PlusOutlined } from '@ant-design/icons';
import {
  Alert, App as AntApp, Button, Card, Col, DatePicker, Descriptions, Input, InputNumber,
  Modal, Radio, Row, Select, Slider, Space, Statistic, Switch, Table, Tabs, Tag, Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import { customersApi, productsApi, promotionsApi, rebatesApi, ApiError } from '../../services/api';
import type {
  CustomerDTO, ProductDTO, PromotionDTO, RebateSchemeDTO, RebateSettlementDTO, RebateSettlementPreviewDTO, RebateSettleTypeDTO, RebateTierDTO, RebateTypeDTO,
} from '../../services/api';
import {
  REBATE_SETTLEMENT_STATUS_META, REBATE_SETTLE_TYPE_META, REBATE_TYPE_META,
} from '../../constants/labels';
import type { Decimalish } from '../../utils/format';
import { currentMonth, fmtDate, fmtDateTime, fmtMoney, recentMonths, toNum } from '../../utils/format';

/** 费率展示：0.01-0.50 → 1%-50%（先归整规避 0.01×100 的浮点尾差） */
function fmtRate(rate: Decimalish): string {
  const pct = Math.round(toNum(rate) * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** 方案状态：closedAt 优先，其次 validTo 是否已过 */
function schemeStatusTag(s: RebateSchemeDTO): JSX.Element {
  if (s.closedAt) return <Tag color="default">已关闭</Tag>;
  if (s.validTo && new Date(s.validTo).getTime() < Date.now()) return <Tag color="default">已到期</Tag>;
  return <Tag color="success">生效中</Tag>;
}

export default function RebatesPage(): JSX.Element {
  return (
    <PageContainer title="优惠返利" subTitle="D02 b/c 互斥 · 坎级阶梯 · 月末核算（货补/票折/现金） · 随单赠买N送M">
      <Card>
        <Tabs
          defaultActiveKey="schemes"
          items={[
            { key: 'schemes', label: '返利方案', children: <SchemesTab /> },
            { key: 'settlements', label: '月末核算', children: <SettlementsTab /> },
            { key: 'promotions', label: '随单赠(买N送M)', children: <PromotionsTab /> },
          ]}
        />
      </Card>
    </PageContainer>
  );
}

// ───────────────────────── Tab3 随单赠·买N送M（C组 M3-1，下单管线自动挂赠品行） ─────────────────────────

function PromotionsTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState<PromotionDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [productId, setProductId] = useState<string>();
  const [giftProductId, setGiftProductId] = useState<string>();
  const [buyQty, setBuyQty] = useState(10);
  const [giftQty, setGiftQty] = useState(1);
  const [validTo, setValidTo] = useState<string>();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setRows(await promotionsApi.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载随单赠规则失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (createOpen) {
      productsApi.list({ page: 1, pageSize: 200 }).then((r) => setProducts(r.items)).catch(() => setProducts([]));
      setProductId(undefined); setGiftProductId(undefined); setBuyQty(10); setGiftQty(1); setValidTo(undefined); setNote('');
    }
  }, [createOpen]);

  async function submit(): Promise<void> {
    if (!productId) { message.warning('请选择商品'); return; }
    if (!(buyQty >= 1 && giftQty >= 1)) { message.warning('买/送数量须 ≥ 1'); return; }
    setSubmitting(true);
    try {
      await promotionsApi.create({ productId, giftProductId: giftProductId || undefined, buyQty, giftQty, validTo: validTo || undefined, note: note.trim() || undefined });
      message.success('规则已创建并即时生效（下单自动挂赠品行）');
      setCreateOpen(false);
      void load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  const productOptions = products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert
        type="info" showIcon
        message="买N送M：内勤开单/业务员代下/客户商城三入口下单时自动按规则追加 0 价赠品行（计入库存与拣货，不占信用），行的促销说明留痕在订单明细。"
      />
      <Space wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建规则</Button>
      </Space>
      <Table<PromotionDTO>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: '暂无随单赠规则' }}
        columns={[
          {
            title: '商品', width: 220,
            render: (_v, r) => (
              <Space size={0} direction="vertical">
                <span>{r.productName}（{r.skuCode}）</span>
              </Space>
            ),
          },
          {
            title: '规则', width: 160,
            render: (_v, r) => <Tag color="red">买{r.buyQty}{r.unitLabel}送{r.giftQty}{r.giftProductName === r.productName ? '' : `(${r.giftProductName})`}</Tag>,
          },
          { title: '生效期', width: 200, render: (_v, r) => `${fmtDate(r.validFrom)} ~ ${r.validTo ? fmtDate(r.validTo) : '长期'}` },
          { title: '状态', width: 90, render: (_v, r) => (r.active ? <Tag color="success">生效中</Tag> : <Tag>{r.closedAt ? '已关闭' : '未生效/已过期'}</Tag>) },
          { title: '备注', dataIndex: 'note', ellipsis: true, render: (v) => v ?? '-' },
          {
            title: '操作', width: 90,
            render: (_v, r) => r.active ? (
              <a onClick={() => modal.confirm({
                title: `关闭规则：${r.productName} 买${r.buyQty}送${r.giftQty}？`,
                content: '关闭后新订单不再自动挂赠品；历史订单不受影响。',
                okText: '关闭规则',
                okButtonProps: { danger: true },
                onOk: async () => {
                  try { await promotionsApi.close(r.id, '手动关闭'); message.success('已关闭'); void load(); }
                  catch (e) { message.error(e instanceof Error ? e.message : '操作失败'); }
                },
              })}>关闭</a>
            ) : '-',
          },
        ]}
      />
      <Modal
        open={createOpen}
        title="新建随单赠规则（买N送M）"
        okText="创建并生效"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={submit}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Select
            style={{ width: '100%' }} showSearch optionFilterProp="label"
            placeholder="商品（买了它才计数，按箱）"
            value={productId}
            onChange={setProductId}
            options={productOptions}
          />
          <Select
            style={{ width: '100%' }} showSearch optionFilterProp="label" allowClear
            placeholder="赠品（选填，默认=商品本身）"
            value={giftProductId}
            onChange={setGiftProductId}
            options={productOptions}
          />
          <Space wrap>
            <Typography.Text>买</Typography.Text>
            <InputNumber min={1} precision={0} style={{ width: 90 }} value={buyQty} onChange={(v) => setBuyQty(v ?? 1)} />
            <Typography.Text>箱 送</Typography.Text>
            <InputNumber min={1} precision={0} style={{ width: 90 }} value={giftQty} onChange={(v) => setGiftQty(v ?? 1)} />
          </Space>
          <Space wrap>
            <Typography.Text type="secondary">结束日期</Typography.Text>
            <DatePicker placeholder="选填=长期" onChange={(d) => setValidTo(d ? d.format('YYYY-MM-DD') : undefined)} />
          </Space>
          <Input.TextArea rows={2} maxLength={100} placeholder="备注（选填，如：旺季促销）" value={note} onChange={(e) => setNote(e.target.value)} />
        </Space>
      </Modal>
    </Space>
  );
}

// ───────────────────────── Tab1 返利方案（b/c 互斥生效中唯一） ─────────────────────────

function SchemesTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [filterCustomerId, setFilterCustomerId] = useState<string>();
  const [rows, setRows] = useState<RebateSchemeDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const reload = useCallback((): void => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    customersApi.list({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    rebatesApi
      .listSchemes({ customerId: filterCustomerId || undefined })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) message.error(e instanceof Error ? e.message : '加载方案失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filterCustomerId, refreshKey, message]);

  /** 关闭方案（生效中 → 关闭，此后可另建新方案；关闭不可逆） */
  function closeScheme(s: RebateSchemeDTO): void {
    modal.confirm({
      title: `关闭返利方案？${s.customer?.name ?? s.customerId}`,
      content: `${REBATE_TYPE_META[s.type]?.label ?? s.type} · 费率 ${fmtRate(s.rate)}。关闭后该客户可另建新方案（互斥以生效中为准），关闭不可逆。`,
      okText: '确认关闭',
      cancelText: '取消',
      onOk: async () => {
        try {
          await rebatesApi.closeScheme(s.id);
          message.success('方案已关闭');
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '关闭失败');
        }
      },
    });
  }

  const customerOptions = customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert
        type="info"
        showIcon
        message="互斥规则（D02）：同一客户同一时刻仅一个生效中的返利方案（b/c 任选其一）；b 除瓶箱后按当月回款 1%-50% 月末核算，c 定扣货款直接冲应收。"
      />
      <Space wrap>
        <Select
          style={{ width: 240 }}
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder="按客户筛选（默认全部）"
          value={filterCustomerId}
          onChange={(v) => setFilterCustomerId(v)}
          options={customerOptions}
        />
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建方案</Button>
      </Space>
      <Table<RebateSchemeDTO>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: '暂无返利方案' }}
        columns={[
          {
            title: '客户', dataIndex: 'customerId', width: 200,
            render: (_v, r) => (
              <Space size={0} direction="vertical">
                <span>{r.customer?.name ?? r.customerId}</span>
                {r.customer && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.customer.code}</Typography.Text>}
              </Space>
            ),
          },
          {
            title: '类型', dataIndex: 'type', width: 120,
            render: (_v, r) => {
              const meta = REBATE_TYPE_META[r.type];
              return <Tag color={meta?.color}>{meta?.label ?? r.type}</Tag>;
            },
          },
          {
            title: '费率', dataIndex: 'rate', width: 150, align: 'right' as const,
            render: (_v, r) => (r.tiers?.length
              ? <span>{[...r.tiers].sort((a, b) => toNum(a.minAmount) - toNum(b.minAmount)).map((t) => `≥${toNum(t.minAmount) / 10000}万:${fmtRate(t.rate)}`).join(' ')}</span>
              : fmtRate(r.rate)),
          },
          {
            title: '生效期', width: 200,
            render: (_v, r) => `${fmtDate(r.validFrom)} ~ ${r.validTo ? fmtDate(r.validTo) : '长期'}`,
          },
          { title: '状态', width: 90, render: (_v, r) => schemeStatusTag(r) },
          { title: '备注', dataIndex: 'note', ellipsis: true, render: (v) => v ?? '-' },
          { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (v) => fmtDateTime(v) },
          {
            title: '操作', width: 90,
            render: (_v, r) => (!r.closedAt ? <a onClick={() => closeScheme(r)}>关闭方案</a> : '-'),
          },
        ]}
      />
      <CreateSchemeModal
        open={createOpen}
        customerOptions={customerOptions}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); reload(); }}
      />
    </Space>
  );
}

// ───────────────────────── 新建方案（客户 + 类型 + 费率滑条 1%-50% + 生效期） ─────────────────────────

function CreateSchemeModal({
  open, customerOptions, onClose, onCreated,
}: {
  open: boolean;
  customerOptions: Array<{ value: string; label: string }>;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [customerId, setCustomerId] = useState<string>();
  const [type, setType] = useState<RebateTypeDTO>('B');
  const [ratePct, setRatePct] = useState(10);
  const [useTiers, setUseTiers] = useState(false);
  const [tiers, setTiers] = useState<Array<{ minAmount: number; ratePct: number }>>([{ minAmount: 10000, ratePct: 2 }, { minAmount: 50000, ratePct: 5 }]);
  const [validTo, setValidTo] = useState<string>();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerId(undefined);
    setType('B');
    setRatePct(10);
    setUseTiers(false);
    setTiers([{ minAmount: 10000, ratePct: 2 }, { minAmount: 50000, ratePct: 5 }]);
    setValidTo(undefined);
    setNote('');
  }, [open]);

  async function submit(): Promise<void> {
    if (!customerId) { message.warning('请选择客户'); return; }
    let tierInput: RebateTierDTO[] | undefined;
    if (useTiers) {
      const valid = tiers.filter((t) => t.minAmount > 0 && t.ratePct > 0);
      if (valid.length === 0) { message.warning('坎级至少一档（门槛与费率 > 0）'); return; }
      const sorted = [...valid].sort((a, b) => a.minAmount - b.minAmount);
      if (sorted.some((t) => t.ratePct < 1 || t.ratePct > 50)) { message.warning('每档费率须在 1% - 50% 之间'); return; }
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].minAmount <= sorted[i - 1].minAmount) { message.warning('坎级门槛须严格递增'); return; }
      }
      tierInput = sorted.map((t) => ({ minAmount: t.minAmount, rate: t.ratePct / 100 }));
    } else if (ratePct < 1 || ratePct > 50) {
      message.warning('费率须在 1% - 50% 之间'); return;
    }
    setSubmitting(true);
    try {
      await rebatesApi.createScheme({
        customerId,
        type,
        rate: (useTiers ? Math.max(...(tierInput ?? []).map((t) => t.rate)) : ratePct / 100),
        tiers: tierInput,
        validTo: validTo || undefined,
        note: note.trim() || undefined,
      });
      // 创建响应不带客户信息，名字从本地选项取
      const cust = customerOptions.find((o) => o.value === customerId)?.label ?? customerId;
      message.success(`方案已创建并生效（今天起）：${cust} · ${REBATE_TYPE_META[type]?.label ?? type} ${useTiers ? `坎级${tierInput?.length}档` : `${ratePct}%`}`);
      onCreated();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // D02 互斥：同客户已有生效中方案（后端拒），弹窗突出展示
        modal.error({ title: '互斥校验未通过（D02）', content: e.message });
      } else {
        message.error(e instanceof Error ? e.message : '创建方案失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建返利方案"
      okText="创建并生效"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
      width={560}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Select
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
          placeholder="选客户（必填）"
          value={customerId}
          onChange={setCustomerId}
          options={customerOptions}
        />
        <Radio.Group
          value={type}
          onChange={(e: RadioChangeEvent) => setType(e.target.value)}
          options={[
            { value: 'B', label: 'B 除瓶箱返利（月末核算）' },
            { value: 'C', label: 'C 定扣货款（直接冲应收）' },
          ]}
          optionType="button"
          buttonStyle="solid"
        />
        {!useTiers && (
          <Space wrap align="center">
            <Typography.Text type="secondary">费率</Typography.Text>
            <InputNumber
              min={1}
              max={50}
              step={0.5}
              precision={1}
              style={{ width: 100 }}
              suffix="%"
              value={ratePct}
              onChange={(v) => setRatePct(v ?? 5)}
            />
            <Slider
              style={{ width: 240, marginInline: 8 }}
              min={1}
              max={50}
              step={0.5}
              value={ratePct}
              onChange={setRatePct}
              marks={{ 5: '5%', 20: '20%', 35: '35%', 50: '50%' }}
              tooltip={{ formatter: (v) => `${v ?? 0}%` }}
            />
          </Space>
        )}
        <Space wrap align="center">
          <Switch checked={useTiers} onChange={setUseTiers} checkedChildren="坎级阶梯" unCheckedChildren="单一费率" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            坎级：按月累计基数取最高命中档费率；未达最低门槛当月无返利（M3-2）
          </Typography.Text>
        </Space>
        {useTiers && (
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            {tiers.map((t, i) => (
              <Space key={i} wrap>
                <Typography.Text type="secondary">月基数 ≥</Typography.Text>
                <InputNumber
                  min={1} precision={0} style={{ width: 130 }}
                  prefix="¥" value={t.minAmount}
                  onChange={(v) => setTiers((prev) => prev.map((x, idx) => (idx === i ? { ...x, minAmount: v ?? 1 } : x)))}
                />
                <Typography.Text type="secondary">费率</Typography.Text>
                <InputNumber
                  min={1} max={50} step={0.5} precision={1} style={{ width: 90 }}
                  suffix="%" value={t.ratePct}
                  onChange={(v) => setTiers((prev) => prev.map((x, idx) => (idx === i ? { ...x, ratePct: v ?? 1 } : x)))}
                />
                {tiers.length > 1 && (
                  <a style={{ color: '#cf1322' }} onClick={() => setTiers((prev) => prev.filter((_, idx) => idx !== i))}>删除</a>
                )}
              </Space>
            ))}
            <Button size="small" onClick={() => setTiers((prev) => [...prev, { minAmount: Math.max(...prev.map((t) => t.minAmount)) * 2, ratePct: 5 }])}>
              ＋ 加一档
            </Button>
          </Space>
        )}
        <Space wrap>
          <Typography.Text type="secondary">生效期：今天起</Typography.Text>
          <DatePicker
            style={{ width: 200 }}
            placeholder="结束日期（选填=长期）"
            onChange={(d) => setValidTo(d ? d.format('YYYY-MM-DD') : undefined)}
          />
        </Space>
        <Input.TextArea
          rows={2}
          maxLength={200}
          showCount
          placeholder="备注（选填，如协议依据）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          同一客户已有生效中方案时后端将拒绝（D02 互斥）；费率限定 1% - 50%（需求 v1.1 M3-2）。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

// ───────────────────────── Tab2 月末核算（preview 测算 → 确认货补/票折） ─────────────────────────

function SettlementsTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [period, setPeriod] = useState<string>(currentMonth());
  const [customerId, setCustomerId] = useState<string>();
  const [preview, setPreview] = useState<RebateSettlementPreviewDTO | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [settleType, setSettleType] = useState<RebateSettleTypeDTO>('INVOICE');
  const [rows, setRows] = useState<RebateSettlementDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    customersApi.list({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    rebatesApi
      .listSettlements({ period })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) message.error(e instanceof Error ? e.message : '加载核算记录失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period, refreshKey, message]);

  const customerName = (id: string): string => customers.find((c) => c.id === id)?.name ?? id;

  async function runPreview(): Promise<void> {
    if (!customerId) { message.warning('请选择客户'); return; }
    setPreviewing(true);
    try {
      const res = await rebatesApi.previewSettlement({ customerId, period });
      setPreview(res);
    } catch (e) {
      setPreview(null);
      message.error(e instanceof Error ? e.message : '测算失败（该客户当月可能无生效方案或无回款基数）');
    } finally {
      setPreviewing(false);
    }
  }

  /** 确认核算：INVOICE=票折冲应收 / GOODS=货补走随单赠下单 */
  function confirmSettle(): void {
    if (!preview) return;
    const typeMeta = REBATE_SETTLE_TYPE_META[settleType];
    modal.confirm({
      title: `确认核算？${customerName(preview.customerId)} · ${preview.period}`,
      content: (
        <div style={{ marginTop: 12 }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="计提基数">{fmtMoney(preview.baseAmount)}</Descriptions.Item>
            <Descriptions.Item label="返利额">{fmtMoney(preview.rebateAmount)}</Descriptions.Item>
            <Descriptions.Item label="结算方式">{typeMeta?.label ?? settleType}</Descriptions.Item>
          </Descriptions>
          <Alert
            style={{ marginTop: 12 }}
            type={settleType === 'INVOICE' ? 'warning' : 'info'}
            showIcon
            message={settleType === 'INVOICE'
              ? '票折：确认后写入 REBATE_OFFSET 流水直接冲减该客户应收，不可撤销。'
              : settleType === 'CASH'
                ? '现金：确认后生成「返利现金」费用单（已批待付），到费用中心执行付款。'
                : '货补：确认后仅登记返利额，请走随单赠下单发放（不反改原单）。'}
          />
        </div>
      ),
      okText: '确认核算',
      cancelText: '取消',
      onOk: async () => {
        setConfirming(true);
        try {
          await rebatesApi.createSettlement({
            customerId: preview.customerId,
            period: preview.period,
            settleType,
          });
          message.success(settleType === 'INVOICE'
            ? '票折核算完成，已冲减该客户应收'
            : settleType === 'CASH'
              ? '现金核算完成，返利费用单已生成（费用中心执行付款）'
              : '货补核算完成，请走随单赠下单发放');
          setPreview(null);
          setRefreshKey((k) => k + 1);
        } catch (e) {
          message.error(e instanceof Error ? e.message : '核算失败（该客户该月可能已核算过，或未达坎级门槛）');
        } finally {
          setConfirming(false);
        }
      },
    });
  }

  const monthOptions = recentMonths(18).map((m) => ({ value: m, label: m }));

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap>
        <Select style={{ width: 130 }} value={period} onChange={(v) => { setPeriod(v); setPreview(null); }} options={monthOptions} />
        <Select
          style={{ width: 240 }}
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder="选客户（核算对象）"
          value={customerId}
          onChange={(v) => { setCustomerId(v); setPreview(null); }}
          options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
        />
        <Button type="primary" loading={previewing} onClick={() => void runPreview()}>预览测算</Button>
      </Space>

      {preview && (
        <Card size="small" title={`测算结果 · ${customerName(preview.customerId)} · ${preview.period}`}>
          <Row gutter={16}>
            <Col span={8}>
              <Statistic title="计提基数（当月回款−瓶箱押金）" value={toNum(preview.baseAmount)} precision={2} prefix="¥" />
            </Col>
            <Col span={8}>
              <Statistic title="返利额（基数×费率）" value={toNum(preview.rebateAmount)} precision={2} prefix="¥" valueStyle={{ color: '#389e0d' }} />
            </Col>
            <Col span={8} style={{ display: 'flex', alignItems: 'center' }}>
              <Button type="primary" loading={confirming} onClick={confirmSettle}>确认核算</Button>
            </Col>
          </Row>
          {(preview.payments !== undefined || preview.rate !== undefined) && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
              口径：当月确认回款 {fmtMoney(preview.payments ?? 0)} − 瓶箱押金支出 {fmtMoney(preview.bottlesDeposit ?? 0)}
              {preview.rate !== undefined && <> × 费率 {fmtRate(preview.rate)}（{REBATE_TYPE_META[preview.schemeType ?? 'B']?.label}{preview.tierHit !== null && preview.tierHit !== undefined ? ` · 坎级命中≥${toNum(preview.tierHit as number)}` : ''}）</>}
            </Typography.Paragraph>
          )}
          <Space style={{ marginTop: 12 }} wrap align="center">
            <Typography.Text type="secondary">结算方式</Typography.Text>
            <Radio.Group
              value={settleType}
              onChange={(e: RadioChangeEvent) => setSettleType(e.target.value)}
              options={[
                { value: 'INVOICE', label: '票折（冲应收）' },
                { value: 'GOODS', label: '货补（随单赠下单）' },
                { value: 'CASH', label: '现金（费用单付款）' },
              ]}
              optionType="button"
              buttonStyle="solid"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {settleType === 'INVOICE'
                ? '票折：REBATE_OFFSET 流水直接冲减该客户应收。'
                : settleType === 'CASH'
                  ? '现金：生成返利现金费用单，出纳在费用中心付款（留付款凭证）。'
                  : '货补：不反改原单，请走随单赠下单发放。'}
            </Typography.Text>
          </Space>
        </Card>
      )}

      <Table<RebateSettlementDTO>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: `${period} 暂无核算记录` }}
        columns={[
          { title: '期间', dataIndex: 'period', width: 100 },
          {
            title: '客户', dataIndex: 'customerId', width: 200,
            render: (_v, r) => (
              <Space size={0} direction="vertical">
                <span>{r.customer?.name ?? customerName(r.customerId)}</span>
                {r.customer && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.customer.code}</Typography.Text>}
              </Space>
            ),
          },
          { title: '计提基数', dataIndex: 'baseAmount', width: 120, align: 'right' as const, render: (v) => fmtMoney(v) },
          { title: '返利额', dataIndex: 'rebateAmount', width: 120, align: 'right' as const, render: (v) => fmtMoney(v) },
          {
            title: '结算方式', dataIndex: 'settleType', width: 100,
            render: (_v, r) => {
              const meta = REBATE_SETTLE_TYPE_META[r.settleType];
              return <Tag color={meta?.color}>{meta?.label ?? r.settleType}</Tag>;
            },
          },
          {
            title: '状态', dataIndex: 'status', width: 90,
            render: (_v, r) => {
              const meta = REBATE_SETTLEMENT_STATUS_META[r.status];
              return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
            },
          },
          { title: '确认时间', dataIndex: 'confirmedAt', width: 150, render: (v) => (v ? fmtDateTime(v) : '-') },
          { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (v) => fmtDateTime(v) },
        ]}
      />
    </Space>
  );
}
