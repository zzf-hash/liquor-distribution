// 审批中心（P1-T01）：五条审批线统一待办——待办/已决 tab + payload 线内详情展开 + 通过/驳回（必填意见留痕）
// 金额路由（D01：≤¥2000 内勤可批 / >¥2000 或低于成本须老板）由后端强制，此处仅提示。
import { useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Card, Descriptions, Input, Modal, Space, Tabs, Tag, Typography,
} from 'antd';
import { approvalsApi } from '../../services/api';
import type { ApprovalRecordDTO } from '../../services/api';
import { APPROVAL_LINE_LABELS, APPROVAL_STATUS_META, labelOf } from '../../constants/labels';
import { fmtDateTime, fmtMoney } from '../../utils/format';

// 已决 tab 拉三种终态（status 逗号多值，EXPIRED_24H=超时24h自动退回不自动通过）
const DECIDED_STATUS = 'APPROVED,REJECTED,EXPIRED_24H';

/** payload 值降级为可展示文本（对象/数组压成紧凑 JSON） */
function payloadText(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function ApprovalsPage(): JSX.Element {
  return (
    <PageContainer title="待审批" subTitle="五条审批线统一：信用放行 / 特殊订单价格 / 改价格 / 采购 / 运营费 / 退货">
      <Card>
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="审批权限：金额 ≤ ¥2,000 内勤可批；> ¥2,000 或低于成本须老板审批（服务端强制校验）。超时 24h 自动退回，不自动通过（D01）。"
        />
        <Tabs
          defaultActiveKey="pending"
          items={[
            { key: 'pending', label: '待办', children: <ApprovalsTab status="PENDING" /> },
            { key: 'decided', label: '已决', children: <ApprovalsTab status={DECIDED_STATUS} /> },
          ]}
        />
      </Card>
    </PageContainer>
  );
}

function ApprovalsTab({ status }: { status: string }): JSX.Element {
  const { message } = AntApp.useApp();
  const [refreshKey, setRefreshKey] = useState(0);
  const [decideState, setDecideState] = useState<{ action: 'approve' | 'reject'; record: ApprovalRecordDTO } | null>(null);

  const columns: ProColumns<ApprovalRecordDTO>[] = [
    { title: '审批事项', dataIndex: 'title', ellipsis: true, render: (_, r) => (
      <Space size={4}>
        <Typography.Text copyable={{ text: r.entityId }} type="secondary" style={{ fontSize: 12 }}>
          #{r.entityType}
        </Typography.Text>
        <span>{r.title}</span>
      </Space>
    ) },
    { title: '审批线', dataIndex: 'line', width: 100, render: (_, r) => <Tag color="geekblue">{labelOf(APPROVAL_LINE_LABELS, r.line)}</Tag> },
    { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (_, r) => (
      r.amount === null || r.amount === undefined ? '-' : fmtMoney(r.amount)
    ) },
    { title: '申请人', dataIndex: ['applicant', 'name'], width: 100 },
    { title: '状态', dataIndex: 'status', width: 100, render: (_, r) => {
      const meta = APPROVAL_STATUS_META[r.status];
      return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
    } },
    { title: '申请时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', valueType: 'option', width: 130,
      render: (_, r) => r.status === 'PENDING' ? (
        <Space size={4}>
          <a onClick={() => setDecideState({ action: 'approve', record: r })}>通过</a>
          <a style={{ color: '#cf1322' }} onClick={() => setDecideState({ action: 'reject', record: r })}>驳回</a>
        </Space>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {r.approver?.name ? `${r.approver.name} · ${fmtDateTime(r.decidedAt)}` : '-'}
        </Typography.Text>
      ),
    },
  ];

  return (
    <>
      <ProTable<ApprovalRecordDTO>
        rowKey="id"
        search={false}
        options={{ reload: true, density: false, setting: false }}
        params={{ _k: refreshKey }}
        request={async (params) => {
          try {
            const res = await approvalsApi.list({
              status,
              page: params.current ?? 1,
              pageSize: params.pageSize ?? 20,
            });
            return { data: res.items, total: res.total, success: true };
          } catch (e) {
            message.error(e instanceof Error ? e.message : '加载审批记录失败');
            return { data: [], total: 0, success: false };
          }
        }}
        columns={columns}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        expandable={{
          expandedRowRender: (r) => <ApprovalDetailCard record={r} />,
          rowExpandable: (r) => Boolean(r.payload && Object.keys(r.payload).length > 0) || Boolean(r.opinion),
        }}
      />
      <DecideModal
        state={decideState}
        onClose={() => setDecideState(null)}
        onDone={() => { setDecideState(null); setRefreshKey((k) => k + 1); }}
      />
    </>
  );
}

// ───────────────────────── 行展开：payload 线内详情（如特单字段快照） ─────────────────────────

function ApprovalDetailCard({ record }: { record: ApprovalRecordDTO }): JSX.Element {
  const payload = record.payload ?? {};
  return (
    <Card size="small" title="线内详情">
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="申请理由" span={2}>{record.reason}</Descriptions.Item>
        {Object.entries(payload).map(([k, v]) => (
          <Descriptions.Item key={k} label={k} span={typeof v === 'object' && v !== null ? 2 : 1}>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{payloadText(v)}</span>
          </Descriptions.Item>
        ))}
        {record.opinion && (
          <Descriptions.Item label="审批意见" span={2}>{record.opinion}</Descriptions.Item>
        )}
      </Descriptions>
    </Card>
  );
}

// ───────────────────────── 通过 / 驳回（必填意见留痕） ─────────────────────────

function DecideModal({
  state, onClose, onDone,
}: {
  state: { action: 'approve' | 'reject'; record: ApprovalRecordDTO } | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [opinion, setOpinion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isReject = state?.action === 'reject';

  // 关闭即复位（下一次打开是干净表单）
  function handleClose(): void {
    setOpinion('');
    onClose();
  }

  async function submit(): Promise<void> {
    if (!state) return;
    if (!opinion.trim()) {
      message.warning('请填写审批意见（审计留痕，必填）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await approvalsApi.decide(state.record.id, state.action, opinion.trim());
      message.success(`${isReject ? '已驳回' : '已通过'}：${res.title ?? state.record.title}`);
      setOpinion('');
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '审批操作失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={state !== null}
      title={isReject ? '驳回审批（需填写意见）' : '通过审批（需填写意见）'}
      okText={isReject ? '确认驳回' : '确认通过'}
      okButtonProps={{ danger: isReject }}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={handleClose}
      destroyOnClose
    >
      {state && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="审批事项">{state.record.title}</Descriptions.Item>
            <Descriptions.Item label="审批线">{labelOf(APPROVAL_LINE_LABELS, state.record.line)}</Descriptions.Item>
            <Descriptions.Item label="金额">
              {state.record.amount === null || state.record.amount === undefined ? '-' : fmtMoney(state.record.amount)}
            </Descriptions.Item>
            <Descriptions.Item label="申请理由">{state.record.reason}</Descriptions.Item>
          </Descriptions>
          <Input.TextArea
            rows={3}
            maxLength={200}
            showCount
            placeholder={isReject ? '请填写驳回意见（必填，审计留痕）' : '请填写审批意见（必填，审计留痕）'}
            value={opinion}
            onChange={(e) => setOpinion(e.target.value)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            金额路由由服务端校验：≤¥2,000 内勤可批，超限将返回权限错误
          </Typography.Text>
        </Space>
      )}
    </Modal>
  );
}
