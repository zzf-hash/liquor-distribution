// 应收台账（P0-T30~T31）：账龄分档 tab（档位可配 M9-3）/ 收款登记（幂等键）/ 待确认收款→确认销账（二次确认摘要）
import { useEffect, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { DownloadOutlined, SettingOutlined } from '@ant-design/icons';
import {
  App as AntApp, Button, Card, Descriptions, Input, InputNumber, Modal,
  Select, Space, Table, Tag, Typography,
} from 'antd';
import { agingApi, customersApi, downloadApiFile, receivablesApi } from '../../services/api';
import { getAuth } from '../../services/auth';
import type {
  AgingConfigDTO,
  ArBucketDTO,
  CustomerDTO,
  PaymentDTO,
  ReceivableDTO,
} from '../../services/api';
import { AR_BUCKET_TABS, SETTLEMENT_LABELS, arBucketTabs, labelOf } from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney } from '../../utils/format';

const NEG = '#cf1322';
const PAYMENT_METHODS = ['现金', '转账', '返利抵扣'];

export default function ReceivablesPage(): JSX.Element {
  const { message } = AntApp.useApp();
  const [bucket, setBucket] = useState<ArBucketDTO>('not_due');
  const [refreshKey, setRefreshKey] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [payRefreshKey, setPayRefreshKey] = useState(0);
  // M9-3 账龄档位（租户级可配，默认 30/50/90）
  const [bucketTabs, setBucketTabs] = useState(AR_BUCKET_TABS);
  const [agingOpen, setAgingOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const role = getAuth()?.role ?? '';
  const canWaive = role === 'owner' || role === 'clerk';
  const canWriteOff = role === 'owner';
  const [fundAction, setFundAction] = useState<{ type: 'waive' | 'writeoff'; row: ReceivableDTO } | null>(null);

  useEffect(() => {
    agingApi.get()
      .then((r) => setBucketTabs(arBucketTabs(r.config)))
      .catch(() => setBucketTabs(AR_BUCKET_TABS)); // 配置拉取失败用默认档位
  }, [refreshKey]);

  const columns: ProColumns<ReceivableDTO>[] = [
    { title: '单据号', dataIndex: 'sourceDocNo', width: 160, render: (_, r) => (
      <Space size={4}>
        <Typography.Text copyable>{r.sourceDocNo}</Typography.Text>
        {r.sourceType === 'INITIAL' && <Tag>期初</Tag>}
      </Space>
    ) },
    { title: '客户', dataIndex: 'customerName', width: 150 },
    { title: '应收金额', dataIndex: 'total', width: 120, align: 'right', render: (_, r) => fmtMoney(r.total) },
    { title: '已收', dataIndex: 'settled', width: 110, align: 'right', render: (_, r) => fmtMoney(r.settled) },
    { title: '未收', dataIndex: 'open', width: 120, align: 'right', render: (_, r) => (
      <span style={{ color: r.open > 0 && r.bucket !== 'not_due' ? NEG : undefined }}>{fmtMoney(r.open)}</span>
    ) },
    { title: '到期日', dataIndex: 'dueDate', width: 110, render: (_, r) => fmtDate(r.dueDate) },
    { title: '逾期天数', dataIndex: 'daysOverdue', width: 90, align: 'right', render: (_, r) => (
      r.bucket === 'disputed' ? '-' : (r.daysOverdue > 0 ? <span style={{ color: NEG }}>{r.daysOverdue}</span> : 0)
    ) },
    { title: '争议', dataIndex: 'disputeFlag', width: 80, render: (_, r) => (
      r.disputeFlag ? <Tag color="error">争议</Tag> : <Tag>正常</Tag>
    ) },
    {
      title: '操作', width: 140,
      render: (_, r) => {
        if (!(r.open > 0) || (!canWaive && !canWriteOff)) return '-';
        return (
          <Space size={8}>
            {canWaive && <a onClick={() => setFundAction({ type: 'waive', row: r })}>抹零</a>}
            {canWriteOff && <a onClick={() => setFundAction({ type: 'writeoff', row: r })}>坏账</a>}
          </Space>
        );
      },
    },
  ];

  return (
    <PageContainer title="应收台账" subTitle="账期自定义 · 到期/超期分档 · 争议款单列（不进提醒 D11）">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card>
          <Space style={{ marginBottom: 12 }} wrap>
            <Select
              style={{ width: 160 }}
              value={bucket}
              onChange={(v) => { setBucket(v as ArBucketDTO); setRefreshKey((k) => k + 1); }}
              options={bucketTabs}
            />
            <Button type="primary" onClick={() => setPayOpen(true)}>收款登记</Button>
            <Button
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await downloadApiFile(`/receivables/export?bucket=${bucket}`, '应收台账');
                  message.success('应收台账已导出');
                } catch (e) {
                  message.error(e instanceof Error ? e.message : '导出失败');
                } finally {
                  setExporting(false);
                }
              }}
            >
              导出 xlsx
            </Button>
            <Button icon={<SettingOutlined />} onClick={() => setAgingOpen(true)}>账龄档位</Button>
          </Space>
          <ProTable<ReceivableDTO>
            rowKey="id"
            search={false}
            options={false}
            params={{ _k: refreshKey }}
            request={async (params) => {
              try {
                const res = await receivablesApi.list({
                  bucket,
                  page: params.current ?? 1,
                  pageSize: params.pageSize ?? 20,
                });
                return { data: res.items, total: res.total, success: true };
              } catch (e) {
                message.error(e instanceof Error ? e.message : '加载应收失败');
                return { data: [], total: 0, success: false };
              }
            }}
            columns={columns}
            pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          />
        </Card>

        <PendingPaymentsCard refreshKey={payRefreshKey} onChanged={() => setPayRefreshKey((k) => k + 1)} />
      </Space>

      <PaymentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onSaved={() => { setPayOpen(false); setRefreshKey((k) => k + 1); setPayRefreshKey((k) => k + 1); }}
      />

      <AgingConfigModal
        open={agingOpen}
        onClose={() => setAgingOpen(false)}
        onSaved={() => { setAgingOpen(false); setRefreshKey((k) => k + 1); }}
      />
      <FundActionModal
        state={fundAction}
        onClose={() => setFundAction(null)}
        onDone={() => { setFundAction(null); setRefreshKey((k) => k + 1); }}
      />
    </PageContainer>
  );
}

function FundActionModal({
  state, onClose, onDone,
}: {
  state: { type: 'waive' | 'writeoff'; row: ReceivableDTO } | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state) {
      setAmount(state.type === 'waive' ? null : state.row.open);
      setReason('');
    }
  }, [state]);

  async function submit(): Promise<void> {
    if (!state) return;
    if (!reason.trim()) {
      message.warning('请填写原因');
      return;
    }
    if (state.type === 'waive' && (!amount || amount <= 0)) {
      message.warning('请填写抹零金额');
      return;
    }
    setSubmitting(true);
    try {
      if (state.type === 'waive') {
        await receivablesApi.waive(state.row.id, amount as number, reason.trim());
        message.success('抹零已提交');
      } else {
        await receivablesApi.writeOff(state.row.id, reason.trim());
        message.success('坏账已核销');
      }
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
      title={state?.type === 'writeoff' ? '坏账核销' : '抹零'}
      okText={state?.type === 'writeoff' ? '确认核销' : '提交抹零'}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => { void submit(); }}
      onCancel={onClose}
      destroyOnClose
    >
      {state && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>
            {state.row.sourceDocNo} · {state.row.customerName} · 未结 {fmtMoney(state.row.open)}
          </Typography.Text>
          {state.type === 'waive' ? (
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              max={state.row.open}
              value={amount ?? undefined}
              placeholder="抹零金额（必填，不超过未结）"
              onChange={(v) => setAmount(typeof v === 'number' ? v : null)}
            />
          ) : (
            <Typography.Text type="secondary">
              将按未结余额整笔核销，金额由服务端计算。
            </Typography.Text>
          )}
          <Input.TextArea
            rows={3}
            maxLength={200}
            value={reason}
            placeholder={state.type === 'waive' ? '抹零原因（必填）' : '坏账原因（必填）'}
            onChange={(e) => setReason(e.target.value)}
          />
        </Space>
      )}
    </Modal>
  );
}

// ───────────────────────── 账龄档位设置（M9-3，仅老板；档位租户级可配） ─────────────────────────

function AgingConfigModal({
  open, onClose, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [cfg, setCfg] = useState<AgingConfigDTO | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setCfg(null);
      agingApi.get().then((r) => setCfg(r.config)).catch(() => setCfg(null));
    }
  }, [open]);

  async function save(): Promise<void> {
    if (!cfg) return;
    if (!(cfg.b1 >= 1 && cfg.b2 > cfg.b1 && cfg.b3 > cfg.b2 && cfg.b3 <= 365)) {
      message.warning('档位须满足 1 ≤ 第一档 < 第二档 < 第三档 ≤ 365');
      return;
    }
    setSaving(true);
    try {
      const next = await agingApi.save(cfg);
      message.success(`账龄档位已更新：${next.b1}/${next.b2}/${next.b3} 天`);
      onSaved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const items: Array<{ key: keyof AgingConfigDTO; label: string; hint: string }> = [
    { key: 'b1', label: '第一档（天）', hint: '逾期 ≤ 此天数' },
    { key: 'b2', label: '第二档（天）', hint: `逾期 ${cfg ? cfg.b1 + 1 : 31} ~ 此天数` },
    { key: 'b3', label: '第三档（天）', hint: `超过第二档到此天数，超过此天数即最高档` },
  ];

  return (
    <Modal
      open={open}
      title="账龄档位设置（租户级）"
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={save}
      onCancel={onClose}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        需求已确认默认 30/50/90 天（第二档较常见 30/60/90 收紧 10 天）。修改仅影响分档展示与提醒，不改历史数据；仅老板可保存。
      </Typography.Paragraph>
      {cfg ? (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {items.map((it) => (
            <Space key={it.key} align="center">
              <Typography.Text style={{ width: 96 }}>{it.label}</Typography.Text>
              <InputNumber
                min={1}
                max={365}
                precision={0}
                value={cfg[it.key]}
                onChange={(v) => setCfg({ ...cfg, [it.key]: v ?? cfg[it.key] })}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{it.hint}</Typography.Text>
            </Space>
          ))}
        </Space>
      ) : (
        <Typography.Text type="secondary">正在加载当前档位…</Typography.Text>
      )}
    </Modal>
  );
}

// ───────────────────────── 收款登记（幂等键防双写） ─────────────────────────

function PaymentModal({
  open, onClose, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [customerId, setCustomerId] = useState<string>();
  const [amount, setAmount] = useState<number>();
  const [method, setMethod] = useState('转账');
  const [voucher, setVoucher] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setCustomerId(undefined);
      setAmount(undefined);
      setMethod('转账');
      setVoucher('');
      setNote('');
      customersApi.list({ page: 1, pageSize: 200 })
        .then((r) => setCustomers(r.items))
        .catch(() => setCustomers([]));
    }
  }, [open]);

  async function submit(): Promise<void> {
    if (!customerId) {
      message.warning('请选择收款客户');
      return;
    }
    if (!amount || amount <= 0) {
      message.warning('请输入正确的收款金额');
      return;
    }
    setSubmitting(true);
    try {
      // api 层自动带 Idempotency-Key（P0-03 幂等，重试不双写）
      const res = await receivablesApi.createPayment({
        customerId,
        amount,
        method,
        voucher: voucher || undefined,
        note: note || undefined,
      });
      message.success(`收款已登记：${res.paymentNo ?? ''}（待确认后 FIFO 销账）`);
      onSaved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '收款登记失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="收款登记"
      okText="登记"
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
          placeholder="选择收款客户"
          value={customerId}
          onChange={setCustomerId}
          options={customers.map((c) => ({
            value: c.id,
            label: `${c.name}（${c.code}·${labelOf(SETTLEMENT_LABELS, c.settlement)}）`,
          }))}
        />
        <Space wrap>
          <InputNumber
            min={0.01}
            precision={2}
            style={{ width: 180 }}
            prefix="¥"
            placeholder="收款金额"
            value={amount}
            onChange={(v) => setAmount(v ?? undefined)}
          />
          <Select style={{ width: 130 }} value={method} onChange={setMethod}
            options={PAYMENT_METHODS.map((m) => ({ value: m, label: m }))} />
        </Space>
        <Input placeholder="凭证号（转账流水/收据号）" value={voucher} onChange={(e) => setVoucher(e.target.value)} />
        <Input.TextArea rows={2} placeholder="备注（如抹零/返利抵扣说明）" value={note} onChange={(e) => setNote(e.target.value)} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          登记后进入「待确认收款」，由内勤确认后按 FIFO 核销（F9 ①→②）
        </Typography.Text>
      </Space>
    </Modal>
  );
}

// ───────────────────────── 待确认收款 → 确认销账 ─────────────────────────

function PendingPaymentsCard({
  refreshKey, onChanged,
}: {
  refreshKey: number;
  onChanged: () => void;
}): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState<PaymentDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    receivablesApi.listPayments({ status: 'REPORTED' })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) message.error(e instanceof Error ? e.message : '加载待确认收款失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refreshKey, confirming, message]);

  function confirmSettle(p: PaymentDTO): void {
    modal.confirm({
      title: '确认销账？',
      content: (
        <Descriptions size="small" column={1} bordered style={{ marginTop: 12 }}>
          <Descriptions.Item label="收款单号">{p.paymentNo}</Descriptions.Item>
          <Descriptions.Item label="客户">{p.customer?.name ?? p.customerId}</Descriptions.Item>
          <Descriptions.Item label="金额">
            <span style={{ color: NEG, fontWeight: 600 }}>{fmtMoney(p.amount)}</span>
          </Descriptions.Item>
          <Descriptions.Item label="方式">{p.method ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="凭证">{p.voucher ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="登记时间">{fmtDateTime(p.createdAt)}</Descriptions.Item>
        </Descriptions>
      ),
      okText: '确认销账',
      cancelText: '取消',
      onOk: async () => {
        try {
          await receivablesApi.confirmPayment(p.id);
          message.success(`已销账：${p.paymentNo}`);
          setConfirming((n) => n + 1);
          onChanged();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '销账失败');
        }
      },
    });
  }

  return (
    <Card size="small" title={`待确认收款（${rows.length}）`} extra="F9②：业务员上报 → 内勤确认 → FIFO 销账">
      <Table<PaymentDTO>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: '暂无待确认收款' }}
        columns={[
          { title: '收款单号', dataIndex: 'paymentNo', width: 200, render: (v: string) => <Typography.Text copyable>{v}</Typography.Text> },
          { title: '客户', width: 150, render: (_, r) => r.customer?.name ?? r.customerId },
          { title: '金额', dataIndex: 'amount', width: 120, align: 'right' as const, render: (v: PaymentDTO['amount']) => fmtMoney(v) },
          { title: '方式', dataIndex: 'method', width: 100, render: (v: string | null) => v ?? '-' },
          { title: '凭证', dataIndex: 'voucher', width: 160, render: (v: string | null) => v ?? '-' },
          { title: '登记时间', dataIndex: 'createdAt', width: 150, render: (v: string) => fmtDateTime(v) },
          { title: '操作', width: 110, render: (_, r) => (
            <a onClick={() => confirmSettle(r)}>确认销账</a>
          ) },
        ]}
      />
    </Card>
  );
}
