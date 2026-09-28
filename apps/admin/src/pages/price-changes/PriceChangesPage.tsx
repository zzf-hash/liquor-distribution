// 调价（P1-T05，F7）：草稿→待审批（PRICE_CHANGE 线）→已批→「一键生效」落新价格版本行。
// D08 红线：只新增版本不覆盖历史，历史单据价格不变；R7/D15：存货增贬值仅测算登记不自动调账。
// 成本价（COST）调价仅老板可发起，非老板不展示该价级（后端亦强校验）。
import { useEffect, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, DatePicker, Descriptions, Input, InputNumber,
  Modal, Select, Space, Spin, Steps, Table, Tag, Typography,
} from 'antd';
import { priceChangesApi, pricesApi, productsApi } from '../../services/api';
import type {
  PriceChangeDTO,
  ProductDTO,
  PriceVersionDTO,
  PriceUnitDTO,
} from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import {
  PRICE_CHANGE_STATUS_META,
  PRICE_CHANGE_STATUS_TABS,
  PRICE_LEVEL_LABELS,
  PRICE_UNIT_LABELS,
  labelOf,
} from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, toNum } from '../../utils/format';

/** 当前 (unit,levelType) 最新生效价（与后端快照口径一致：validFrom≤now 且未失效，取最新） */
function currentPriceOf(rows: PriceVersionDTO[], unit: PriceUnitDTO, levelType: string): number | null {
  const now = Date.now();
  return rows
    .filter((r) => r.unit === unit && r.levelType === levelType)
    .filter((r) => new Date(r.validFrom).getTime() <= now && (!r.validTo || new Date(r.validTo).getTime() >= now))
    .sort((a, b) => new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime())
    .map((r) => toNum(r.price))[0] ?? null;
}

export default function PriceChangesPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const [activeStatus, setActiveStatus] = useState('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = (): void => setRefreshKey((k) => k + 1);

  /** DRAFT → 提交审批（生成 PRICE_CHANGE 待办，去审批中心处理） */
  function submitForApproval(r: PriceChangeDTO): void {
    modal.confirm({
      title: `提交调价审批？${labelOf(PRICE_LEVEL_LABELS, r.levelType)} ${fmtMoney(r.oldPrice)} → ${fmtMoney(r.newPrice)}`,
      content: '提交后进入审批中心（调价线）待审批；审批通过后需回本页「一键生效」落新价格版本。',
      okText: '提交审批',
      cancelText: '再想想',
      onOk: async () => {
        try {
          await priceChangesApi.submit(r.id);
          message.success('已提交审批，请到「审批中心」（调价线）处理');
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '提交失败');
        }
      },
    });
  }

  /** APPROVED → 一键生效（D08：插入新价格版本行，历史单据不变） */
  function effectuate(r: PriceChangeDTO): void {
    modal.confirm({
      title: `一键生效？${labelOf(PRICE_LEVEL_LABELS, r.levelType)} → ${fmtMoney(r.newPrice)}`,
      content: (
        <div style={{ marginTop: 12 }}>
          <Alert
            type="info"
            showIcon
            message="按生效日生成一条新的价格版本行（D08：只新增版本不覆盖历史，历史单据价格不变）；存货增贬值仅登记测算，不自动调账。"
          />
          <Descriptions size="small" column={1} bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label="商品">{r.product?.name ?? r.productId}</Descriptions.Item>
            <Descriptions.Item label="生效日">{fmtDate(r.effectiveDate)}</Descriptions.Item>
            <Descriptions.Item label="调价理由">{r.reason}</Descriptions.Item>
          </Descriptions>
        </div>
      ),
      okText: '确认生效',
      cancelText: '取消',
      onOk: async () => {
        try {
          await priceChangesApi.effectuate(r.id);
          message.success(`调价已生效，新价格版本已生成（生效日 ${fmtDate(r.effectiveDate)}）`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '生效失败');
        }
      },
    });
  }

  const columns: ProColumns<PriceChangeDTO>[] = [
    {
      title: '商品', dataIndex: 'productId', width: 200,
      render: (_, r) => (
        <Space size={0} direction="vertical">
          <span>{r.product?.name ?? r.productId}</span>
          {r.product && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.product.skuCode}</Typography.Text>}
        </Space>
      ),
    },
    {
      title: '价级', dataIndex: 'levelType', width: 150,
      render: (_, r) => (
        <Space size={0} direction="vertical">
          <span>{labelOf(PRICE_LEVEL_LABELS, r.levelType)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{PRICE_UNIT_LABELS[r.unit] ?? r.unit}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '旧价 → 新价', dataIndex: 'newPrice', width: 180, align: 'right',
      render: (_, r) => {
        const oldN = toNum(r.oldPrice);
        const newN = toNum(r.newPrice);
        const color = newN > oldN ? '#cf1322' : newN < oldN ? '#389e0d' : undefined;
        return (
          <Space size={6}>
            <Typography.Text type="secondary">{fmtMoney(oldN)}</Typography.Text>
            <span style={{ color }}>→</span>
            <Typography.Text strong style={{ color }}>{fmtMoney(newN)}</Typography.Text>
          </Space>
        );
      },
    },
    { title: '生效日', dataIndex: 'effectiveDate', width: 110, render: (_, r) => fmtDate(r.effectiveDate) },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (_, r) => {
        const meta = PRICE_CHANGE_STATUS_META[r.status];
        return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
      },
    },
    { title: '发起时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', valueType: 'option', width: 110,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'DRAFT' && <a onClick={() => submitForApproval(r)}>提交审批</a>}
          {r.status === 'APPROVED' && <a onClick={() => effectuate(r)}>一键生效</a>}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer title="调价" subTitle="F7 调价引擎 · 只新增版本不覆盖历史（D08） · 存货增贬值仅测算登记（R7）">
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 130 }}
            value={activeStatus}
            onChange={(v) => { setActiveStatus(v); reload(); }}
            options={PRICE_CHANGE_STATUS_TABS}
          />
          <Button type="primary" onClick={() => setCreateOpen(true)}>发起调价</Button>
        </Space>
        <ProTable<PriceChangeDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await priceChangesApi.list({
                status: activeStatus === 'ALL' ? undefined : activeStatus,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载调价单失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          expandable={{ expandedRowRender: (r) => <PriceChangeDetailCard record={r} /> }}
        />
      </Card>

      <CreatePriceChangeModal
        role={role}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 行展开：调价详情 + 存货增贬值测算 ─────────────────────────

function PriceChangeDetailCard({ record }: { record: PriceChangeDTO }): JSX.Element {
  const impact = record.stockImpact;
  const delta = impact ? toNum(impact.deltaAmount) : 0;
  return (
    <Card size="small" title="调价详情">
      <Descriptions size="small" column={3} bordered>
        <Descriptions.Item label="调价理由" span={3}>{record.reason}</Descriptions.Item>
        <Descriptions.Item label="在库量">
          {impact ? toNum(impact.onHandQty) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="价差">
          {impact ? fmtMoney(toNum(impact.newPrice) - toNum(impact.oldPrice)) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="存货增贬值（测算）">
          {impact ? (
            <span style={{ color: delta > 0 ? '#389e0d' : delta < 0 ? '#cf1322' : undefined, fontWeight: 600 }}>
              {fmtMoney(delta)}
              {delta > 0 ? '（增值）' : delta < 0 ? '（贬值）' : '（无影响）'}
            </span>
          ) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="生效时间">{record.effectuatedAt ? fmtDateTime(record.effectuatedAt) : '未生效'}</Descriptions.Item>
        <Descriptions.Item label="客户专属价联动">{record.customerSync ? '提示联动' : '不联动'}</Descriptions.Item>
        <Descriptions.Item label="审批单">{record.approvalId ?? '-'}</Descriptions.Item>
      </Descriptions>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        R7/D15：增贬值仅登记不自动调账；客户专属价不自动修改，需在主数据单独维护。
      </Typography.Text>
    </Card>
  );
}

// ───────────────────────── 发起调价（表单 → 存货测算确认 → 提交审批） ─────────────────────────

/** 可调价级：COST 仅老板可见（后端 create 对非老板 409 强校验） */
const CHANGEABLE_LEVELS = ['TIER1', 'TIER2', 'TERMINAL', 'RETAIL'];

function CreatePriceChangeModal({
  role, open, onClose, onDone,
}: {
  role: Role;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const isOwner = role === 'owner';
  // 阶段：0 填写表单 → 1 已建草稿（存货测算 + 提交审批）
  const [step, setStep] = useState(0);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [productId, setProductId] = useState<string>();
  const [unit, setUnit] = useState<PriceUnitDTO>('BASE');
  const [levelType, setLevelType] = useState<string>('TERMINAL');
  const [oldPrice, setOldPrice] = useState<number | null | undefined>(undefined);
  const [priceLoading, setPriceLoading] = useState(false);
  const [newPrice, setNewPrice] = useState<number>();
  const [effectiveDate, setEffectiveDate] = useState<string>();
  const [reason, setReason] = useState('');
  const [created, setCreated] = useState<PriceChangeDTO | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const levelOptions = (isOwner ? ['COST', ...CHANGEABLE_LEVELS] : CHANGEABLE_LEVELS).map((v) => ({
    value: v,
    label: labelOf(PRICE_LEVEL_LABELS, v),
  }));

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setProductId(undefined);
    setUnit('BASE');
    setLevelType('TERMINAL');
    setOldPrice(undefined);
    setNewPrice(undefined);
    setEffectiveDate(undefined);
    setReason('');
    setCreated(null);
    productsApi.list({ page: 1, pageSize: 200, status: 'ON_SALE' })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, [open]);

  // 选齐（商品,单位,价级）→ 自动带出当前最新生效价（GET /products/:id/prices）
  useEffect(() => {
    if (!productId) { setOldPrice(undefined); return; }
    let alive = true;
    setPriceLoading(true);
    setOldPrice(undefined);
    pricesApi
      .listForProduct(productId)
      .then((rows) => { if (alive) setOldPrice(currentPriceOf(rows, unit, levelType)); })
      .catch(() => { if (alive) setOldPrice(null); })
      .finally(() => { if (alive) setPriceLoading(false); });
    return () => { alive = false; };
  }, [productId, unit, levelType]);

  async function createDraft(): Promise<void> {
    if (!productId) { message.warning('请选择商品'); return; }
    if (newPrice === undefined || newPrice === null) { message.warning('请填写新价'); return; }
    if (!effectiveDate) { message.warning('请选择生效日'); return; }
    if (!reason.trim()) { message.warning('调价理由必填'); return; }
    setSubmitting(true);
    try {
      const res = await priceChangesApi.create({
        productId,
        unit,
        levelType,
        newPrice,
        effectiveDate,
        reason: reason.trim(),
      });
      setCreated(res);
      setStep(1);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建调价草稿失败');
    } finally {
      setSubmitting(false);
    }
  }

  /** 草稿 → 提交 PRICE_CHANGE 审批（审批中心待办） */
  async function submitApproval(): Promise<void> {
    if (!created) return;
    setSubmitting(true);
    try {
      await priceChangesApi.submit(created.id);
      message.success('已提交审批，请到「审批中心」（调价线）处理');
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '提交审批失败');
    } finally {
      setSubmitting(false);
    }
  }

  const impact = created?.stockImpact;
  const delta = impact ? toNum(impact.deltaAmount) : 0;
  const impactRows: Array<{ key: string; label: string; value: string; color?: string; note?: string }> = [
    { key: 'onHandQty', label: '当前在库量', value: impact ? String(toNum(impact.onHandQty)) : '-' },
    { key: 'diff', label: '价差', value: impact ? fmtMoney(toNum(impact.newPrice) - toNum(impact.oldPrice)) : '-' },
    {
      key: 'delta',
      label: '存货增贬值',
      value: impact ? fmtMoney(delta) : '-',
      color: delta > 0 ? '#389e0d' : delta < 0 ? '#cf1322' : undefined,
      note: delta > 0 ? '涨价 → 存货增值' : delta < 0 ? '降价 → 存货贬值' : '无影响',
    },
  ];

  return (
    <Modal
      open={open}
      title="发起调价"
      width={720}
      footer={step === 0
        ? [
          <Button key="cancel" onClick={onClose}>取消</Button>,
          <Button key="create" type="primary" loading={submitting} onClick={createDraft}>生成调价草稿</Button>,
        ]
        : [
          <Button key="keep" onClick={onDone}>暂存草稿</Button>,
          <Button key="submit" type="primary" loading={submitting} onClick={submitApproval}>提交审批</Button>,
        ]}
      onCancel={step === 0 ? onClose : onDone}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Steps
          size="small"
          current={step}
          items={[{ title: '填写调价' }, { title: '存货增贬值测算' }, { title: '提交审批' }]}
        />

        {step === 0 && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Space wrap>
              <Select
                style={{ minWidth: 240 }}
                showSearch
                optionFilterProp="label"
                placeholder="选择商品"
                value={productId}
                onChange={setProductId}
                options={products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))}
              />
              <Select
                style={{ width: 140 }}
                value={unit}
                onChange={setUnit}
                options={(['BASE', 'MIN'] as PriceUnitDTO[]).map((v) => ({ value: v, label: PRICE_UNIT_LABELS[v] }))}
              />
              <Select style={{ width: 140 }} value={levelType} onChange={setLevelType} options={levelOptions} />
            </Space>
            {!isOwner && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                成本价调整仅老板（OWNER）可发起，如需调成本价请联系老板。
              </Typography.Text>
            )}

            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="当前生效价">
                {priceLoading ? <Spin size="small" /> : oldPrice === undefined
                  ? '请先选齐商品 / 单位 / 价级'
                  : oldPrice === null
                    ? <Typography.Text type="secondary">该价级暂无生效价（本次为首次定价）</Typography.Text>
                    : <Typography.Text strong>{fmtMoney(oldPrice)}</Typography.Text>}
              </Descriptions.Item>
            </Descriptions>

            <Space wrap>
              <InputNumber
                min={0}
                precision={2}
                style={{ width: 160 }}
                prefix="¥"
                placeholder="新价"
                value={newPrice}
                onChange={(v) => setNewPrice(v ?? undefined)}
              />
              <DatePicker
                style={{ width: 180 }}
                placeholder="生效日（新版本 validFrom）"
                onChange={(d) => setEffectiveDate(d ? d.format('YYYY-MM-DD') : undefined)}
              />
            </Space>

            <Input.TextArea
              rows={3}
              maxLength={200}
              showCount
              placeholder="调价理由（必填，如：厂家提价 / 市场竞争 / 促销结束恢复）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              D08：生效时只新增价格版本行，历史单据价格不变；生效前需经审批中心（调价线）审批。
            </Typography.Text>
          </Space>
        )}

        {step === 1 && created && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Alert type="success" showIcon message="调价草稿已创建，存货增贬值测算如下（仅登记，不自动调账）" />
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="商品">{created.product?.name ?? created.productId}</Descriptions.Item>
              <Descriptions.Item label="价级">
                {labelOf(PRICE_LEVEL_LABELS, created.levelType)} · {PRICE_UNIT_LABELS[created.unit] ?? created.unit}
              </Descriptions.Item>
              <Descriptions.Item label="旧价 → 新价">
                {fmtMoney(created.oldPrice)} → <Typography.Text strong>{fmtMoney(created.newPrice)}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="生效日">{fmtDate(created.effectiveDate)}</Descriptions.Item>
            </Descriptions>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={impactRows}
              columns={[
                { title: '测算项', dataIndex: 'label', width: 140 },
                { title: '数值', dataIndex: 'value', render: (_v, r) => <span style={{ color: r.color, fontWeight: 600 }}>{r.value}</span> },
                { title: '说明', dataIndex: 'note', render: (v) => v ?? '' },
              ]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              提交审批后到「审批中心」（调价线）处理；审批通过回本页「一键生效」落新价格版本。也可暂存草稿稍后提交。
            </Typography.Text>
          </Space>
        )}
      </Space>
    </Modal>
  );
}
