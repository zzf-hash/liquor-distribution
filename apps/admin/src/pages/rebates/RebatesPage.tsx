// 优惠返利（P1-T08，D02 优惠三式 b/c）：b 除瓶箱后 5%-50% 月末核算 / c 定扣货款；
// 同客户同一时刻仅一个生效方案（后端 409 互斥，前端捕获展示）；
// 月末核算：preview 测算基数/返利额 → 确认（GOODS=货补走随单赠下单 / INVOICE=票折冲应收）。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Col, DatePicker, Descriptions, Input, InputNumber,
  Modal, Radio, Row, Select, Slider, Space, Statistic, Table, Tabs, Tag, Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import { customersApi, rebatesApi, ApiError } from '../../services/api';
import type {
  CustomerDTO, RebateSchemeDTO, RebateSettlementDTO, RebateSettlementPreviewDTO, RebateSettleTypeDTO, RebateTypeDTO,
} from '../../services/api';
import {
  REBATE_SETTLEMENT_STATUS_META, REBATE_SETTLE_TYPE_META, REBATE_TYPE_META,
} from '../../constants/labels';
import type { Decimalish } from '../../utils/format';
import { currentMonth, fmtDate, fmtDateTime, fmtMoney, recentMonths, toNum } from '../../utils/format';

/** 费率展示：0.05-0.50 → 5%-50%（先归整规避 0.05×100 的浮点尾差） */
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
    <PageContainer title="优惠返利" subTitle="D02 b/c 互斥 · 月末核算（货补=随单赠下单 / 票折=冲应收）">
      <Card>
        <Tabs
          defaultActiveKey="schemes"
          items={[
            { key: 'schemes', label: '返利方案', children: <SchemesTab /> },
            { key: 'settlements', label: '月末核算', children: <SettlementsTab /> },
          ]}
        />
      </Card>
    </PageContainer>
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
        message="互斥规则（D02）：同一客户同一时刻仅一个生效中的返利方案（b/c 任选其一）；b 除瓶箱后按当月回款 5%-50% 月末核算，c 定扣货款直接冲应收。"
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
          { title: '费率', dataIndex: 'rate', width: 80, align: 'right' as const, render: (_v, r) => fmtRate(r.rate) },
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

// ───────────────────────── 新建方案（客户 + 类型 + 费率滑条 5%-50% + 生效期） ─────────────────────────

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
  const [validTo, setValidTo] = useState<string>();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerId(undefined);
    setType('B');
    setRatePct(10);
    setValidTo(undefined);
    setNote('');
  }, [open]);

  async function submit(): Promise<void> {
    if (!customerId) { message.warning('请选择客户'); return; }
    if (ratePct < 5 || ratePct > 50) { message.warning('费率须在 5% - 50% 之间'); return; }
    setSubmitting(true);
    try {
      await rebatesApi.createScheme({
        customerId,
        type,
        rate: ratePct / 100,
        validTo: validTo || undefined,
        note: note.trim() || undefined,
      });
      // 创建响应不带客户信息，名字从本地选项取
      const cust = customerOptions.find((o) => o.value === customerId)?.label ?? customerId;
      message.success(`方案已创建并生效（今天起）：${cust} · ${REBATE_TYPE_META[type]?.label ?? type} ${ratePct}%`);
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
        <Space wrap align="center">
          <Typography.Text type="secondary">费率</Typography.Text>
          <InputNumber
            min={5}
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
            min={5}
            max={50}
            step={0.5}
            value={ratePct}
            onChange={setRatePct}
            marks={{ 5: '5%', 20: '20%', 35: '35%', 50: '50%' }}
            tooltip={{ formatter: (v) => `${v ?? 0}%` }}
          />
        </Space>
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
          同一客户已有生效中方案时后端将拒绝（D02 互斥）；费率限定 5% - 50%。
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
            : '货补核算完成，请走随单赠下单发放');
          setPreview(null);
          setRefreshKey((k) => k + 1);
        } catch (e) {
          message.error(e instanceof Error ? e.message : '核算失败（该客户该月可能已核算过）');
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
              {preview.rate !== undefined && <> × 费率 {fmtRate(preview.rate)}（{REBATE_TYPE_META[preview.schemeType ?? 'B']?.label}）</>}
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
              ]}
              optionType="button"
              buttonStyle="solid"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {settleType === 'INVOICE'
                ? '票折：REBATE_OFFSET 流水直接冲减该客户应收。'
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
