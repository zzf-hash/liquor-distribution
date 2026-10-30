// 对账中心（P1-T10，月结对账）：按客户+月份生成对账单（期间应收/核销汇总+单据明细行）
// → 推送客户（SENT，客户 miniapp 可见）→ 客户确认（CONFIRMED）或异议（DISPUTED，差异四类工作池）
// → 逐条处理（结论必填），全部处理完自动 RESOLVED。
// 口径：当期发生=期间内应收 CHARGE；当期核销=期间内 SETTLE+REBATE_OFFSET；期末未结=客户当前 open 合计。
import { useCallback, useEffect, useState } from 'react';
import type { Key } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Descriptions, Input, Modal, Select, Space, Table,
  Tabs, Tag, Typography,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { ApiError, customersApi, downloadApiFile, statementsApi } from '../../services/api';
import type { CustomerDTO, DisputeItemDTO, StatementDTO, StatementLineDTO } from '../../services/api';
import {
  DISPUTE_STATUS_META, DISPUTE_TYPE_META, STATEMENT_STATUS_META, STATEMENT_STATUS_TABS,
} from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, recentMonths, toNum } from '../../utils/format';

const NEG = '#cf1322'; // 期末未结红（与应收页同色）

export default function StatementsPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [statusTab, setStatusTab] = useState('ALL');
  const [filterCustomerId, setFilterCustomerId] = useState<string>();
  const [filterPeriod, setFilterPeriod] = useState<string>();
  const [rows, setRows] = useState<StatementDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);
  /** 展开行详情缓存（disputes 只在详情接口返回） */
  const [details, setDetails] = useState<Record<string, StatementDTO>>({});
  const [generateOpen, setGenerateOpen] = useState(false);

  const reload = useCallback((): void => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    customersApi.list({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    statementsApi
      .list({
        status: statusTab === 'ALL' ? undefined : statusTab,
        customerId: filterCustomerId || undefined,
        period: filterPeriod || undefined,
      })
      .then((r) => { if (alive) setRows(Array.isArray(r) ? r : []); })
      .catch((e) => { if (alive) message.error(e instanceof Error ? e.message : '加载对账单失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [statusTab, filterCustomerId, filterPeriod, refreshKey, message]);

  /** 展开行：拉详情（disputes 差异工作池只在详情返回；lines 列表已带） */
  function expandStatement(open: boolean, r: StatementDTO): void {
    if (!open) return;
    if (!details[r.id]) {
      statementsApi
        .detail(r.id)
        .then((d) => setDetails((prev) => ({ ...prev, [r.id]: d })))
        .catch((e) => message.error(e instanceof Error ? e.message : '加载对账单详情失败'));
    }
  }

  /** 推送客户（GENERATED → SENT）；二次确认后提示 */
  function sendStatement(r: StatementDTO): void {
    modal.confirm({
      title: `推送客户？${r.statementNo}`,
      content: `客户 ${r.customer?.name ?? r.customerId} · ${r.period} · 期末未结 ${fmtMoney(r.openBalance)}。推送后客户在小程序端可见，可确认无误或提交异议（漏单/价格/赠品/退货）。`,
      okText: '推送客户',
      cancelText: '取消',
      onOk: async () => {
        try {
          await statementsApi.send(r.id);
          message.success(`已推送客户：${r.statementNo}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '推送失败（仅已生成可推送）');
        }
      },
    });
  }

  const customerOptions = customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }));
  const monthOptions = recentMonths(24).map((m) => ({ value: m, label: m }));

  return (
    <PageContainer title="对账中心" subTitle="月结对账 · 推送客户确认 · 差异四类工作池（漏单/价格/赠品/退货）">
      <Card>
        <Tabs
          activeKey={statusTab}
          onChange={setStatusTab}
          items={STATEMENT_STATUS_TABS.map((t) => ({ key: t.key, label: t.label }))}
        />
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 240 }}
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="按客户筛选（默认全部）"
            value={filterCustomerId}
            onChange={setFilterCustomerId}
            options={customerOptions}
          />
          <Select
            style={{ width: 140 }}
            allowClear
            placeholder="全部期间"
            value={filterPeriod}
            onChange={setFilterPeriod}
            options={monthOptions}
          />
          <Button type="primary" onClick={() => setGenerateOpen(true)}>生成对账单</Button>
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                const qsParams = new URLSearchParams();
                if (statusTab !== 'ALL') qsParams.set('status', statusTab);
                if (filterPeriod) qsParams.set('period', filterPeriod);
                const qsStr = qsParams.toString();
                await downloadApiFile(`/statements/export${qsStr ? `?${qsStr}` : ''}`, '对账单');
                message.success('对账单已导出');
              } catch (e) {
                message.error(e instanceof Error ? e.message : '导出失败');
              }
            }}
          >
            导出 xlsx
          </Button>
        </Space>
        <Table<StatementDTO>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          locale={{ emptyText: '暂无对账单，点「生成对账单」按客户+月份生成' }}
          expandable={{
            expandedRowKeys: expandedKeys,
            onExpandedRowsChange: (keys) => setExpandedKeys(keys),
            onExpand: expandStatement,
            expandedRowRender: (r) => (
              <ExpandedStatement
                row={r}
                detail={details[r.id]}
                onResolved={() => {
                  // 差异处理后：重取该单详情（差异池保持展开最新），列表状态可能翻 RESOLVED
                  statementsApi
                    .detail(r.id)
                    .then((d) => setDetails((prev) => ({ ...prev, [r.id]: d })))
                    .catch(() => undefined);
                  reload();
                }}
              />
            ),
          }}
          columns={[
            { title: '对账单号', dataIndex: 'statementNo', width: 170 },
            {
              title: '客户', dataIndex: 'customerId', width: 200,
              render: (_v, r) => (
                <Space size={0} direction="vertical">
                  <span>{r.customer?.name ?? r.customerId}</span>
                  {r.customer && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.customer.code}</Typography.Text>}
                </Space>
              ),
            },
            { title: '期间', dataIndex: 'period', width: 100 },
            { title: '当期发生', dataIndex: 'totalCharged', width: 120, align: 'right' as const, render: (v) => fmtMoney(v) },
            { title: '当期核销', dataIndex: 'totalSettled', width: 120, align: 'right' as const, render: (v) => fmtMoney(v) },
            {
              title: '期末未结', dataIndex: 'openBalance', width: 120, align: 'right' as const,
              render: (v) => <span style={{ fontWeight: 600, color: toNum(v) > 0 ? NEG : undefined }}>{fmtMoney(v)}</span>,
            },
            {
              title: '状态', dataIndex: 'status', width: 110,
              render: (_v, r) => {
                const meta = STATEMENT_STATUS_META[r.status];
                return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
              },
            },
            { title: '生成时间', dataIndex: 'createdAt', width: 150, render: (v) => fmtDateTime(v) },
            {
              title: '操作', width: 90,
              render: (_v, r) => (r.status === 'GENERATED'
                ? <a onClick={() => sendStatement(r)}>推送客户</a>
                : '-'),
            },
          ]}
        />
      </Card>
      <GenerateStatementModal
        open={generateOpen}
        customerOptions={customerOptions}
        onClose={() => setGenerateOpen(false)}
        onDone={() => { setGenerateOpen(false); reload(); }}
      />
    </PageContainer>
  );
}

// ───────────────────────── 行展开：单据明细 + 差异工作池 ─────────────────────────

function ExpandedStatement({
  row, detail, onResolved,
}: {
  row: StatementDTO;
  detail?: StatementDTO;
  onResolved: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [resolving, setResolving] = useState<DisputeItemDTO | null>(null);
  const [resolution, setResolution] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const lines = row.lines ?? [];
  const disputes = detail?.disputes ?? [];
  const openCount = disputes.filter((d) => d.status === 'OPEN').length;

  /** 处理差异（结论必填）；处理完刷新详情+列表（状态可能翻 RESOLVED） */
  async function resolve(): Promise<void> {
    if (!resolving) return;
    if (!resolution.trim()) { message.warning('处理结论必填'); return; }
    setSubmitting(true);
    try {
      await statementsApi.resolveDispute(resolving.id, resolution.trim());
      message.success('差异已处理');
      setResolving(null);
      setResolution('');
      onResolved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '处理失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Typography.Text strong>单据明细（{lines.length} 行）</Typography.Text>
      <Table<StatementLineDTO>
        size="small"
        rowKey="docNo"
        pagination={false}
        dataSource={lines}
        locale={{ emptyText: '该期间无应收单据' }}
        columns={[
          { title: '单据号', dataIndex: 'docNo', width: 200 },
          {
            title: '类型', dataIndex: 'type', width: 90,
            render: (v) => (v === 'ORDER' ? '订单' : v === 'INITIAL' ? '期初' : (v ?? '-')),
          },
          { title: '金额', dataIndex: 'total', width: 120, align: 'right' as const, render: (v) => fmtMoney(v) },
          {
            title: '期间核销', dataIndex: 'settledInPeriod', width: 120, align: 'right' as const,
            render: (v) => fmtMoney(v),
          },
          {
            title: '未结', dataIndex: 'open', width: 120, align: 'right' as const,
            render: (v) => <span style={{ color: toNum(v) > 0 ? NEG : undefined }}>{fmtMoney(v)}</span>,
          },
          { title: '日期', dataIndex: 'generatedAt', width: 110, render: (v) => fmtDate(v) },
        ]}
      />

      {(disputes.length > 0 || row.status === 'DISPUTED') && (
        <>
          <Typography.Text strong>
            差异工作池（{disputes.length} 条 · 待处理 {openCount} 条）
          </Typography.Text>
          {!detail ? (
            <Typography.Text type="secondary">正在加载差异项…</Typography.Text>
          ) : disputes.length === 0 ? (
            <Typography.Text type="secondary">该对账单暂无差异项</Typography.Text>
          ) : (
            <Table<DisputeItemDTO>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={disputes}
              locale={{ emptyText: '暂无差异项' }}
              columns={[
                {
                  title: '类型', dataIndex: 'type', width: 90,
                  render: (_v, d) => {
                    const meta = DISPUTE_TYPE_META[d.type];
                    return <Tag color={meta?.color}>{meta?.label ?? d.type}</Tag>;
                  },
                },
                { title: '客户描述', dataIndex: 'content', ellipsis: true },
                {
                  title: '状态', dataIndex: 'status', width: 90,
                  render: (_v, d) => {
                    const meta = DISPUTE_STATUS_META[d.status];
                    return <Tag color={meta?.color}>{meta?.label ?? d.status}</Tag>;
                  },
                },
                { title: '处理结论', dataIndex: 'resolution', ellipsis: true, render: (v) => v ?? '-' },
                { title: '提出时间', dataIndex: 'createdAt', width: 150, render: (v) => fmtDateTime(v) },
                {
                  title: '操作', width: 80,
                  render: (_v, d) => (d.status === 'OPEN'
                    ? <a onClick={() => { setResolving(d); setResolution(''); }}>处理</a>
                    : <Typography.Text type="secondary">已处理</Typography.Text>),
                },
              ]}
            />
          )}
        </>
      )}

      <Modal
        open={resolving !== null}
        title="处理差异"
        okText="提交处理结论"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={() => { void resolve(); }}
        onCancel={() => { setResolving(null); setResolution(''); }}
        destroyOnClose
      >
        {resolving && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Space wrap>
              <Tag color={DISPUTE_TYPE_META[resolving.type]?.color}>
                {DISPUTE_TYPE_META[resolving.type]?.label ?? resolving.type}
              </Tag>
              <Typography.Text type="secondary">{fmtDateTime(resolving.createdAt)}</Typography.Text>
            </Space>
            <Alert type="info" showIcon message={resolving.content} />
            <Input.TextArea
              rows={3}
              maxLength={200}
              showCount
              placeholder="处理结论（必填，如：核对订单/价格已更正/赠品已补发/退货已冲减）"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              处理结论必填；该对账单全部差异处理完后自动置为「差异已解」。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </Space>
  );
}

// ───────────────────────── 生成对账单（选客户+月份 → 摘要二次确认 → 推送） ─────────────────────────

function GenerateStatementModal({
  open, customerOptions, onClose, onDone,
}: {
  open: boolean;
  customerOptions: Array<{ value: string; label: string }>;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [customerId, setCustomerId] = useState<string>();
  const [period, setPeriod] = useState<string>();
  const [created, setCreated] = useState<StatementDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerId(undefined);
    setPeriod(undefined);
    setCreated(null);
  }, [open]);

  async function generate(): Promise<void> {
    if (!customerId) { message.warning('请选择客户'); return; }
    if (!period) { message.warning('请选择月份'); return; }
    setCreating(true);
    try {
      const res = await statementsApi.generate({ customerId, period });
      setCreated(res);
      message.success(`对账单已生成：${res.statementNo}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // tenant+customer+period 唯一：该客户该月已有对账单（后端拒），弹窗突出展示
        modal.error({ title: '该客户本月对账单已存在', content: e.message });
      } else {
        message.error(e instanceof Error ? e.message : '生成对账单失败');
      }
    } finally {
      setCreating(false);
    }
  }

  /** 摘要确认后推送（GENERATED → SENT） */
  async function push(): Promise<void> {
    if (!created) return;
    setSending(true);
    try {
      await statementsApi.send(created.id);
      message.success(`已推送客户：${created.statementNo}`);
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '推送失败');
    } finally {
      setSending(false);
    }
  }

  const lines = created?.lines ?? [];
  const custLabel = customerOptions.find((o) => o.value === customerId)?.label ?? created?.customerId ?? '-';

  return (
    <Modal
      open={open}
      title={created ? `对账单已生成 · ${created.statementNo}` : '生成对账单'}
      okText={created ? '推送客户' : '生成对账单'}
      cancelText={created ? '完成' : '取消'}
      confirmLoading={created ? sending : creating}
      onOk={() => { void (created ? push() : generate()); }}
      onCancel={created ? onDone : onClose}
      width={640}
      destroyOnClose
    >
      {!created ? (
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
          <Select
            style={{ width: '100%' }}
            placeholder="选月份（必填，YYYY-MM）"
            value={period}
            onChange={setPeriod}
            options={recentMonths(24).map((m) => ({ value: m, label: `${m} 月` }))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            口径：当期发生＝期间内应收发生；当期核销＝期间内收款+票折；期末未结＝客户当前未结合计。
            同客户同月份仅一张对账单（重复生成后端拒绝）。
          </Typography.Text>
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="客户">{custLabel}</Descriptions.Item>
            <Descriptions.Item label="期间">{created.period}</Descriptions.Item>
            <Descriptions.Item label="当期发生">{fmtMoney(created.totalCharged)}</Descriptions.Item>
            <Descriptions.Item label="当期核销">{fmtMoney(created.totalSettled)}</Descriptions.Item>
            <Descriptions.Item label="期末未结">
              <span style={{ color: toNum(created.openBalance) > 0 ? NEG : undefined }}>{fmtMoney(created.openBalance)}</span>
            </Descriptions.Item>
            <Descriptions.Item label="明细行数">{lines.length} 行</Descriptions.Item>
          </Descriptions>
          {lines.length > 0 && (
            <Table<StatementLineDTO>
              size="small"
              rowKey="docNo"
              pagination={lines.length > 6 ? { pageSize: 6, size: 'small', hideOnSinglePage: true } : false}
              dataSource={lines}
              locale={{ emptyText: '该期间无应收单据' }}
              columns={[
                { title: '单据号', dataIndex: 'docNo', ellipsis: true },
                {
                  title: '类型', dataIndex: 'type', width: 80,
                  render: (v) => (v === 'ORDER' ? '订单' : v === 'INITIAL' ? '期初' : (v ?? '-')),
                },
                { title: '金额', dataIndex: 'total', width: 110, align: 'right' as const, render: (v) => fmtMoney(v) },
                { title: '日期', dataIndex: 'generatedAt', width: 110, render: (v) => fmtDate(v) },
              ]}
            />
          )}
          <Alert
            type="info"
            showIcon
            message="推送后客户在小程序端可见，可确认无误或提交异议（漏单/价格/赠品/退货四类差异进工作池）。也可稍后在列表中推送。"
          />
        </Space>
      )}
    </Modal>
  );
}
