// 回包装（P1-T04）：有单回填（签收联动）+ F11 无单回收 + 押金退付，台账 append-only。
// 押金=品类 cfg 单价×数量（后端落账为准）；押金余额=Σ(回收+回填)−Σ(退付)。
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  App as AntApp, AutoComplete, Button, Card, Col, Descriptions, Input, InputNumber, Modal,
  Row, Select, Space, Statistic, Tag, Typography,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { customersApi, packagesApi } from '../../services/api';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import type { CustomerDTO, PackageRecordDTO, PackageSummaryDTO } from '../../services/api';
import { PACKAGE_TYPE_META } from '../../constants/labels';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';

/** 品类默认押金单价（镜像后端 cfg 默认表，仅用于表单测算展示，落账以后端为准） */
const DEFAULT_DEPOSIT_RATES: Record<string, number> = { 周转箱: 15, 啤酒瓶: 0.5, 白酒盒: 2 };

/** 客户某品类押金余额（数量口径与金额口径） */
function balanceOf(rows: PackageRecordDTO[]): Map<string, { qty: number; deposit: number }> {
  const m = new Map<string, { qty: number; deposit: number }>();
  for (const r of rows) {
    const sign = r.type === 'OUT' ? -1 : 1;
    const cur = m.get(r.category) ?? { qty: 0, deposit: 0 };
    cur.qty += sign * r.qty;
    cur.deposit += sign * toNum(r.depositPaid);
    m.set(r.category, cur);
  }
  return m;
}

/** 从既有台账反推品类当前押金单价（最新一笔正数记录 |depositPaid|/qty），无记录用默认表 */
function depositRateOf(rows: PackageRecordDTO[], category: string): number {
  const hit = rows.find((r) => r.category === category && r.qty > 0 && toNum(r.depositPaid) !== 0);
  if (hit) return Math.abs(toNum(hit.depositPaid)) / hit.qty;
  return DEFAULT_DEPOSIT_RATES[category] ?? 0;
}

/** CSV 单元格转义（逗号/引号/换行包裹双引号） */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function PackagesPage(): JSX.Element {
  const { message } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [customerId, setCustomerId] = useState<string>();
  const [category, setCategory] = useState<string>();
  const [type, setType] = useState<string>('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const [summary, setSummary] = useState<PackageSummaryDTO | null>(null);
  const [modalMode, setModalMode] = useState<'STANDALONE' | 'OUT' | null>(null);
  const [exporting, setExporting] = useState(false);

  const reload = (): void => setRefreshKey((k) => k + 1);

  useEffect(() => {
    // 不过滤在册状态：停用客户仍可能有在押周转箱需退付
    customersApi.list({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
  }, []);

  // 汇总卡随刷新联动（登记回包装后余额即变）
  useEffect(() => {
    let alive = true;
    packagesApi
      .summary()
      .then((s) => { if (alive) setSummary(s); })
      .catch(() => { if (alive) setSummary(null); });
    return () => { alive = false; };
  }, [refreshKey]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>(Object.keys(DEFAULT_DEPOSIT_RATES));
    for (const i of summary?.items ?? []) set.add(i.category);
    return [...set];
  }, [summary]);

  /** 按当前筛选导出台账 CSV（前端生成，带 BOM 供 Excel 直开） */
  async function exportCsv(): Promise<void> {
    setExporting(true);
    try {
      const pageSize = 200; // 后端单页上限
      const rows: PackageRecordDTO[] = [];
      let page = 1;
      let total = Infinity;
      while (rows.length < total && page <= 50) {
        const res = await packagesApi.list({
          customerId: customerId || undefined,
          category: category || undefined,
          type: type === 'ALL' ? undefined : type,
          page,
          pageSize,
        });
        total = res.total;
        rows.push(...res.items);
        if (res.items.length === 0) break;
        page += 1;
      }
      const header = ['日期', '客户', '客户编码', '品类', '数量', '类型', '押金金额', '关联订单', '备注'];
      const lines = rows.map((r) => [
        fmtDateTime(r.createdAt),
        r.customer?.name ?? r.customerId,
        r.customer?.code ?? '',
        r.category,
        r.qty,
        PACKAGE_TYPE_META[r.type]?.label ?? r.type,
        toNum(r.depositPaid).toFixed(2),
        r.orderId ?? '',
        r.note ?? '',
      ].map(csvCell).join(','));
      const blob = new Blob([`﻿${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `包装物回收台账_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已导出 ${rows.length} 条台账明细`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  const columns: ProColumns<PackageRecordDTO>[] = [
    {
      title: '客户', dataIndex: 'customerId', width: 170,
      render: (_, r) => (
        <Space size={0} direction="vertical">
          <span>{r.customer?.name ?? r.customerId}</span>
          {r.customer && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.customer.code}</Typography.Text>}
        </Space>
      ),
    },
    { title: '品类', dataIndex: 'category', width: 110 },
    { title: '数量', dataIndex: 'qty', width: 80, align: 'right' },
    {
      title: '类型', dataIndex: 'type', width: 100,
      render: (_, r) => {
        const meta = PACKAGE_TYPE_META[r.type];
        return <Tag color={meta?.color}>{meta?.label ?? r.type}</Tag>;
      },
    },
    {
      title: '押金金额', dataIndex: 'depositPaid', width: 110, align: 'right',
      render: (_, r) => {
        const n = toNum(r.depositPaid);
        return <span style={{ color: n < 0 ? '#cf1322' : undefined, fontWeight: 600 }}>{fmtMoney(n)}</span>;
      },
    },
    { title: '关联订单', dataIndex: 'orderId', width: 130, render: (_, r) => r.orderId ? <Typography.Text copyable style={{ fontSize: 12 }}>{r.orderId}</Typography.Text> : '-' },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (_, r) => r.note ?? '-' },
    { title: '日期', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
  ];

  return (
    <PageContainer title="包装物回收" subTitle="F11 无单回收 · 押金台账 append-only · 押金单价后台 cfg 可配">
      {summary && (
        <Row gutter={12} style={{ marginBottom: 12 }}>
          {(summary.items ?? []).map((i) => (
            <Col key={i.category}>
              <Card size="small">
                <Statistic title={`${i.category}（在押 ${i.qty}）`} value={fmtMoney(i.deposit)} />
              </Card>
            </Col>
          ))}
          <Col>
            <Card size="small">
              <Statistic title="押金总额" value={fmtMoney(summary.totalDeposit)} valueStyle={{ color: '#389e0d' }} />
            </Card>
          </Col>
        </Row>
      )}

      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 220 }}
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="按客户筛选"
            value={customerId}
            onChange={(v) => { setCustomerId(v); reload(); }}
            options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
          />
          <Select
            style={{ width: 140 }}
            allowClear
            placeholder="按品类筛选"
            value={category}
            onChange={(v) => { setCategory(v); reload(); }}
            options={categoryOptions.map((c) => ({ value: c, label: c }))}
          />
          <Select
            style={{ width: 130 }}
            value={type}
            onChange={(v) => { setType(v ?? 'ALL'); reload(); }}
            options={[
              { value: 'ALL', label: '全部类型' },
              { value: 'WITH_ORDER', label: '有单回填' },
              { value: 'STANDALONE', label: '无单回收' },
              { value: 'OUT', label: '押金退付' },
            ]}
          />
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={exportCsv}>导出明细</Button>
          <Button onClick={() => setModalMode('OUT')}>押金退付</Button>
          <Button type="primary" onClick={() => setModalMode('STANDALONE')}>无单回收(F11)</Button>
        </Space>
        <ProTable<PackageRecordDTO>
          rowKey="id"
          search={false}
          options={{ reload: true, density: false, setting: false }}
          params={{ _k: refreshKey }}
          request={async (params) => {
            try {
              const res = await packagesApi.list({
                customerId: customerId || undefined,
                category: category || undefined,
                type: type === 'ALL' ? undefined : type,
                page: params.current ?? 1,
                pageSize: params.pageSize ?? 20,
              });
              return { data: res.items, total: res.total, success: true };
            } catch (e) {
              message.error(e instanceof Error ? e.message : '加载包装物回收台账失败');
              return { data: [], total: 0, success: false };
            }
          }}
          columns={columns}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <PackageRecordModal
        open={modalMode !== null}
        mode={modalMode ?? 'STANDALONE'}
        customers={customers}
        categoryOptions={categoryOptions}
        onClose={() => setModalMode(null)}
        onCreated={() => { setModalMode(null); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 无单回收(F11) / 押金退付 登记弹窗 ─────────────────────────

function PackageRecordModal({
  open, mode, customers, categoryOptions, onClose, onCreated,
}: {
  open: boolean;
  mode: 'STANDALONE' | 'OUT';
  customers: CustomerDTO[];
  categoryOptions: string[];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const isOut = mode === 'OUT';
  const [customerId, setCustomerId] = useState<string>();
  const [category, setCategory] = useState('');
  const [qty, setQty] = useState<number>();
  const [note, setNote] = useState('');
  const [customerRows, setCustomerRows] = useState<PackageRecordDTO[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const idemRef = useRef<IdemSlot | null>(null);

  useEffect(() => {
    if (!open) return;
    setCustomerId(undefined);
    setCategory('');
    setQty(undefined);
    setNote('');
    setCustomerRows([]);
  }, [open, mode]);

  // 选定客户 → 拉其台账算各品类押金余额（退付上限）与单价反推
  useEffect(() => {
    if (!customerId) { setCustomerRows([]); return; }
    let alive = true;
    setRowsLoading(true);
    packagesApi
      .list({ customerId, page: 1, pageSize: 200 })
      .then((r) => { if (alive) setCustomerRows(r.items); })
      .catch(() => { if (alive) setCustomerRows([]); })
      .finally(() => { if (alive) setRowsLoading(false); });
    return () => { alive = false; };
  }, [customerId]);

  const balances = balanceOf(customerRows);
  const balance = category ? balances.get(category.trim()) : undefined;
  const rate = category.trim() ? depositRateOf(customerRows, category.trim()) : 0;
  const estimate = rate * (qty ?? 0);

  // 退付只能选有余额的品类；回收可选已知品类或手输新品类（cfg 以后端为准）
  const categorySuggestions = (isOut
    ? [...balances.entries()].filter(([, b]) => b.qty > 0).map(([c]) => c)
    : [...new Set([...categoryOptions, ...balances.keys()])]
  ).map((c) => ({ value: c }));

  async function submit(): Promise<void> {
    if (!customerId) { message.warning('请选择客户'); return; }
    if (!category.trim()) { message.warning('请填写品类'); return; }
    if (!qty || !Number.isInteger(qty) || qty < 1) { message.warning('数量须为正整数'); return; }
    if (isOut && balance && qty > balance.qty) {
      message.warning(`退付数量超该客户在押余额（当前 ${balance.qty}）`);
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        customerId,
        category: category.trim(),
        qty,
        type: mode,
        note: note.trim() || undefined,
      };
      const res = await packagesApi.create(payload, rememberIdemKey(idemRef, payload));
      idemRef.current = null;
      const label = PACKAGE_TYPE_META[mode]?.label ?? mode;
      message.success(
        `${label}已登记：${category.trim()} × ${qty}`
        + (res.depositPaid !== undefined ? `，押金 ${fmtMoney(res.depositPaid)}` : '')
        + (res.replay ? '（幂等重放，未重复入账）' : ''),
      );
      onCreated();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '登记失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title={isOut ? '押金退付（冲减在押余额）' : '无单回收（F11）'}
      okText={isOut ? '确认退付' : '确认回收'}
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
          placeholder="选择客户"
          value={customerId}
          onChange={setCustomerId}
          options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
        />
        <AutoComplete
          style={{ width: '100%' }}
          value={category}
          onChange={setCategory}
          options={categorySuggestions}
          placeholder={isOut ? '选择品类（仅有在押余额的品类）' : '品类（周转箱/啤酒瓶/白酒盒…，可手输）'}
        />
        {isOut && rowsLoading && <Typography.Text type="secondary">正在加载该客户在押余额…</Typography.Text>}
        {isOut && category.trim() && balance && (
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="在押数量">{balance.qty}</Descriptions.Item>
            <Descriptions.Item label="押金余额">{fmtMoney(balance.deposit)}</Descriptions.Item>
          </Descriptions>
        )}
        <InputNumber
          min={1}
          precision={0}
          step={1}
          style={{ width: 200 }}
          placeholder="数量（个/只）"
          value={qty}
          onChange={(v) => setQty(v ?? undefined)}
        />
        <Descriptions size="small" bordered column={1}>
          <Descriptions.Item label={isOut ? '退付测算' : '押金测算'}>
            {`单价 ¥${rate.toFixed(2)} × ${qty ?? 0} = `}
            <Typography.Text strong style={{ color: isOut ? '#cf1322' : undefined }}>
              {fmtMoney(isOut ? -estimate : estimate)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>（以后端 cfg 配置单价落账为准）</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Input.TextArea
          rows={2}
          maxLength={100}
          showCount
          placeholder="备注（如：口头回收/破损扣留）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {isOut
            ? '退付后按品类冲减该客户押金余额（台账只增不改）；超余额后端拒绝。'
            : 'F11 无单回收：未关联订单的周转箱/瓶盒回收登记，押金按品类单价自动计算入账。'}
        </Typography.Text>
      </Space>
    </Modal>
  );
}
