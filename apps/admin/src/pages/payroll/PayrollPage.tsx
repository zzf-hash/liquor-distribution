// 绩效工资（P1-T09，D5 三指标）：选月份 → 业务员绩效卡片（回款/新客/拜访/退货冲减/提成测算）
// → 一键生成工资表（tenant+month 唯一，可复算覆盖）→ 老板确认发放（CONFIRMED 后不可复算）。
// 口径：回款＝当月确认收款×客户归属（D5 归下单人）；拜访数用接口 visitCount；退货当期冲减不回算。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Col, Descriptions, Empty, Row, Select,
  Space, Table, Tag, Typography,
} from 'antd';
import { payrollApi } from '../../services/api';
import type { PayrollDTO, PerformanceItemDTO } from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import { PAYROLL_STATUS_META } from '../../constants/labels';
import { currentMonth, fmtDateTime, fmtMoney, recentMonths, toNum } from '../../utils/format';

export default function PayrollPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const canGenerate = role === 'owner' || role === 'clerk'; // 生成/复算工资表
  const canConfirm = role === 'owner'; // 确认发放
  const [month, setMonth] = useState<string>(currentMonth());
  const [items, setItems] = useState<PerformanceItemDTO[]>([]);
  const [perfLoading, setPerfLoading] = useState(true);
  const [payroll, setPayroll] = useState<PayrollDTO | null>(null);
  const [payrollLoading, setPayrollLoading] = useState(true);
  const [payrollError, setPayrollError] = useState('');
  const [generating, setGenerating] = useState(false);

  const loadPayroll = useCallback(async (m: string): Promise<void> => {
    setPayrollLoading(true);
    setPayrollError('');
    try {
      setPayroll(await payrollApi.get(m));
    } catch (e) {
      // 未生成月份后端 data 为 null；异常（接口未就绪等）提示但不清空已有表
      setPayrollError(e instanceof Error ? e.message : '加载工资表失败');
    } finally {
      setPayrollLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setPerfLoading(true);
    payrollApi
      .performance(month)
      .then((r) => { if (alive) setItems(r.items ?? []); })
      .catch((e) => { if (alive) { setItems([]); message.error(e instanceof Error ? e.message : '加载绩效失败'); } })
      .finally(() => { if (alive) setPerfLoading(false); });
    void loadPayroll(month);
    return () => { alive = false; };
  }, [month, loadPayroll, message]);

  const sumPayment = items.reduce((s, it) => s + toNum(it.paymentAmount), 0);
  const sumCommission = items.reduce((s, it) => s + toNum(it.commission), 0);

  /** 一键生成工资表（二次确认弹窗展示汇总；复算覆盖该月） */
  function generate(): void {
    modal.confirm({
      title: `一键生成工资表？${month}`,
      content: (
        <div style={{ marginTop: 12 }}>
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="业务员">{items.length} 人</Descriptions.Item>
            <Descriptions.Item label="当月回款合计">{fmtMoney(sumPayment)}</Descriptions.Item>
            <Descriptions.Item label="提成合计">{fmtMoney(sumCommission)}</Descriptions.Item>
          </Descriptions>
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message="底薪取系统配置（cfg）；按当月绩效生成该月工资表，重复生成覆盖复算；确认发放后不可再复算。"
          />
        </div>
      ),
      okText: '生成工资表',
      cancelText: '取消',
      onOk: async () => {
        setGenerating(true);
        try {
          const res = await payrollApi.generate(month);
          message.success(`工资表已生成：${res.items?.length ?? 0} 人 · 合计 ${fmtMoney(res.totalAmount)}`);
          await loadPayroll(month);
        } catch (e) {
          message.error(e instanceof Error ? e.message : '生成工资表失败');
        } finally {
          setGenerating(false);
        }
      },
    });
  }

  /** 确认发放（owner；DRAFT → CONFIRMED） */
  function confirmPayroll(): void {
    if (!payroll) return;
    modal.confirm({
      title: `确认发放工资？${payroll.month}`,
      content: `共 ${payroll.items?.length ?? 0} 人 · 合计 ${fmtMoney(payroll.totalAmount)}。确认后工资表置为「已发放」，不可再复算。`,
      okText: '确认发放',
      cancelText: '取消',
      onOk: async () => {
        try {
          await payrollApi.confirm(payroll.id);
          message.success('工资表已确认发放');
          await loadPayroll(month);
        } catch (e) {
          message.error(e instanceof Error ? e.message : '确认发放失败');
        }
      },
    });
  }

  return (
    <PageContainer
      title="绩效工资"
      subTitle="D5 回款70/拜访20/新客10 · 退货当期冲减不回算 · 工资表可复算"
      extra={[
        <Select
          key="month"
          style={{ width: 130 }}
          value={month}
          onChange={setMonth}
          options={recentMonths(18).map((m) => ({ value: m, label: m }))}
        />,
        ...(canGenerate
          ? [<Button key="generate" type="primary" loading={generating} onClick={generate}>一键生成工资表</Button>]
          : []),
      ]}
    >
      <Card
        size="small"
        title={`当月绩效（${month}）`}
        style={{ marginBottom: 12 }}
        extra={<Typography.Text type="secondary">回款合计 {fmtMoney(sumPayment)} · 提成合计 {fmtMoney(sumCommission)}</Typography.Text>}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          口径：回款＝当月确认收款×客户归属（D5 归下单人）；拜访数为接口返回的 visitCount；退货当期冲减不回算。
        </Typography.Paragraph>
        {perfLoading ? (
          <Card size="small" loading style={{ border: 'none' }} />
        ) : items.length === 0 ? (
          <Empty description="该月份暂无业务员绩效数据" />
        ) : (
          <Row gutter={[12, 12]}>
            {items.map((it) => (
              <Col key={it.repId} span={8}>
                <Card size="small" title={it.name}>
                  <Row gutter={[8, 8]}>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>当月回款额</Typography.Text>
                      <div>{fmtMoney(it.paymentAmount)}</div>
                    </Col>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>新客数</Typography.Text>
                      <div>{it.newCustomers}</div>
                    </Col>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>拜访数</Typography.Text>
                      <div>{it.visitCount}</div>
                    </Col>
                    <Col span={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>退货冲减</Typography.Text>
                      <div style={{ color: toNum(it.returnDeduction) !== 0 ? '#cf1322' : undefined }}>
                        {fmtMoney(it.returnDeduction)}
                      </div>
                    </Col>
                    <Col span={16}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>提成测算</Typography.Text>
                      <div style={{ fontSize: 18, fontWeight: 600, color: '#389e0d' }}>{fmtMoney(it.commission)}</div>
                    </Col>
                  </Row>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      <Card
        size="small"
        title={`工资表（${month}）`}
        loading={payrollLoading}
        extra={payroll && canConfirm && payroll.status === 'DRAFT' ? (
          <Button type="primary" onClick={confirmPayroll}>确认发放</Button>
        ) : undefined}
      >
        {payrollError && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={payrollError} />}
        {!payroll ? (
          <Empty description="该月份尚未生成工资表，点上方「一键生成工资表」按当月绩效生成" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Descriptions size="small" column={4} bordered>
              <Descriptions.Item label="月份">{payroll.month}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={PAYROLL_STATUS_META[payroll.status]?.color}>
                  {PAYROLL_STATUS_META[payroll.status]?.label ?? payroll.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="合计">{fmtMoney(payroll.totalAmount)}</Descriptions.Item>
              <Descriptions.Item label="生成时间">{fmtDateTime(payroll.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="确认发放时间">{payroll.confirmedAt ? fmtDateTime(payroll.confirmedAt) : '-'}</Descriptions.Item>
            </Descriptions>
            <Table<PerformanceItemDTO>
              size="small"
              rowKey="repId"
              pagination={false}
              dataSource={payroll.items ?? []}
              locale={{ emptyText: '无工资行' }}
              columns={[
                { title: '业务员', dataIndex: 'name', width: 140 },
                { title: '底薪(cfg)', dataIndex: 'baseSalary', width: 120, align: 'right' as const, render: (v) => fmtMoney(v) },
                {
                  title: '绩效构成', dataIndex: 'commission',
                  render: (_v, it) => (
                    <Space size={0} direction="vertical">
                      <span>提成 {fmtMoney(it.commission)}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        回款 {fmtMoney(it.paymentAmount)} · 新客 {it.newCustomers} · 拜访 {it.visitCount} · 退货冲减 {fmtMoney(it.returnDeduction)}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '合计', dataIndex: 'total', width: 130, align: 'right' as const,
                  render: (v, it) => (
                    <Typography.Text strong>{fmtMoney(v !== null && v !== undefined ? v : toNum(it.baseSalary) + toNum(it.commission))}</Typography.Text>
                  ),
                },
              ]}
              summary={() => (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={3}>
                    <Typography.Text strong>合计</Typography.Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <Typography.Text strong>{fmtMoney(payroll.totalAmount)}</Typography.Text>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />
          </Space>
        )}
      </Card>
    </PageContainer>
  );
}
