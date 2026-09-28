// 送货单套打模板（P0-T24，A4 纵向浏览器打印基线）
// 数据直接用订单详情接口（GET /orders/:id：lines/customer/outbounds/signature），无需后端新接口；
// 红字冲销行负数量红字显示、赠品行标"赠"；纸单（signMode=PAPER）提示打印后走回录通道。
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Result, Space, Spin, Typography } from 'antd';
import { PrinterOutlined, CloseOutlined } from '@ant-design/icons';
import { ordersApi } from '../../services/api';
import type { OrderDTO, OrderLineDTO } from '../../services/api';
import { PRICE_UNIT_LABELS, SIGN_MODE_LABELS, labelOf } from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, toNum } from '../../utils/format';

const MERCHANT_NAME = '示例酒行'; // 商户名占位（正式名走租户配置 M0-01）
const NEG = '#cf1322'; // 红字冲销行

/** 详情接口在 OrderDTO 之外附带的打印要素（customer 选择列/地址快照） */
interface OrderDetailPrint extends OrderDTO {
  addressSnapshot?: string;
  customer?: { code?: string; name?: string; phone?: string } | null;
}

// A4 纵向；@media print 隐藏 .no-print 操作区并还原纸面
const PRINT_CSS = `
@page { size: A4 portrait; margin: 12mm; }
@media print {
  .no-print { display: none !important; }
  body { background: #fff !important; }
  .dn-sheet {
    width: auto !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
}
`;

const sheetStyle: CSSProperties = {
  maxWidth: 800,
  margin: '0 auto',
  padding: 32,
  background: '#fff',
  color: '#000',
  fontSize: 12,
  lineHeight: 1.8,
  boxSizing: 'border-box',
};

const cell: CSSProperties = { border: '1px solid #333', padding: '4px 8px', fontSize: 12 };
const cellRight: CSSProperties = { ...cell, textAlign: 'right' };
const cellHead: CSSProperties = { ...cell, background: '#f2f2f2', fontWeight: 600, textAlign: 'center' };

export default function DeliveryNotePrint(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<OrderDetailPrint | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [printedAt] = useState(() => fmtDateTime(new Date()));

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    ordersApi
      .detail(id ?? '')
      .then((d) => { if (alive) setDetail(d as OrderDetailPrint); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '加载订单失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);

  if (loading) {
    return <div style={{ padding: 80, textAlign: 'center' }}><Spin tip="加载订单中…" /></div>;
  }
  if (error || !detail) {
    return (
      <Result
        status="warning"
        title="无法打印送货单"
        subTitle={error || '订单不存在'}
        extra={<Button type="primary" onClick={() => window.close()}>关闭窗口</Button>}
      />
    );
  }

  const lines = detail.lines ?? [];
  const total = toNum(detail.totalAmount);

  return (
    <div style={{ padding: '24px 16px', background: '#f5f5f5', minHeight: '100vh' }}>
      <style>{PRINT_CSS}</style>

      {/* 操作区：仅屏显，打印时隐藏（.no-print） */}
      <div className="no-print" style={{ maxWidth: 800, margin: '0 auto 16px' }}>
        <Space>
          <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
            打印送货单
          </Button>
          <Button icon={<CloseOutlined />} onClick={() => window.close()}>
            关闭窗口
          </Button>
        </Space>
      </div>

      {detail.signMode === 'PAPER' && (
        <Alert
          className="no-print"
          style={{ maxWidth: 800, margin: '0 auto 16px' }}
          type="warning"
          showIcon
          message="纸单签约订单"
          description="打印后此单走回录通道：交客户纸质签字，签字结果由内勤补录系统后订单才算签收。"
        />
      )}

      <div className="dn-sheet" style={sheetStyle}>
        {/* 抬头 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{MERCHANT_NAME}</div>
            <div style={{ letterSpacing: 2 }}>送 货 单</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div>送货单号：<b style={{ fontSize: 14 }}>{detail.orderNo}</b></div>
            <div>单据状态：{detail.statusLabel ?? detail.status}（{labelOf(SIGN_MODE_LABELS, detail.signMode)}）</div>
            <div>打印时间：{printedAt}</div>
          </div>
        </div>

        {/* 客户信息 */}
        <div style={{ border: '1px solid #333', padding: 8, marginTop: 12 }}>
          <div>客户名称：{detail.customerName}（编码 {detail.customer?.code ?? '-'}）</div>
          <div>联系电话：{detail.customer?.phone ?? '-'}</div>
          <div>送货地址：{detail.addressSnapshot || '-'}</div>
          <div>
            交货日期：{detail.deliveryDate ? fmtDate(detail.deliveryDate) : '按商家安排'}
            ｜来源：{detail.source === 'CUSTOMER' ? '客户商城' : detail.source === 'REP' ? '业务员代下' : '内勤开单'}
          </div>
        </div>

        {/* 行表：品名/规格/单位/数量/单价/金额 */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ ...cellHead, width: '34%' }}>品名</th>
              <th style={{ ...cellHead, width: '17%' }}>规格</th>
              <th style={{ ...cellHead, width: '9%' }}>单位</th>
              <th style={{ ...cellHead, width: '12%' }}>数量</th>
              <th style={{ ...cellHead, width: '13%' }}>单价</th>
              <th style={{ ...cellHead, width: '15%' }}>金额</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l: OrderLineDTO) => {
              const negQty = toNum(l.qty) < 0;
              const negAmt = toNum(l.amount) < 0;
              return (
                <tr key={l.id}>
                  <td style={cell}>
                    {l.productName}
                    {l.isGift && <b>（赠）</b>}
                    {l.reversalOfId && <span style={{ color: NEG }}>（红字冲销）</span>}
                  </td>
                  <td style={cell}>{l.specText || '-'}</td>
                  <td style={{ ...cell, textAlign: 'center' }}>{labelOf(PRICE_UNIT_LABELS, l.unit)}</td>
                  <td style={{ ...cellRight, color: negQty ? NEG : undefined }}>{toNum(l.qty)}</td>
                  <td style={cellRight}>{fmtMoney(l.unitPrice)}</td>
                  <td style={{ ...cellRight, color: negAmt ? NEG : undefined }}>{fmtMoney(l.amount)}</td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr><td style={cell} colSpan={6}>（无明细行）</td></tr>
            )}
            <tr>
              <td style={cell} colSpan={4}>合计（红字冲销已冲减，共 {lines.length} 行）</td>
              <td style={cellRight} colSpan={2}>
                <b style={{ fontSize: 14, color: total < 0 ? NEG : undefined }}>{fmtMoney(detail.totalAmount)}</b>
              </td>
            </tr>
          </tbody>
        </table>

        {/* 签收栏：客户签名 / 日期 / 回包装登记 */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24 }}>
          <tbody>
            <tr>
              <td style={{ ...cell, width: '40%', padding: '14px 8px' }}>客户签名：</td>
              <td style={{ ...cell, width: '26%', padding: '14px 8px' }}>签收日期：　　年　　月　　日</td>
              <td style={{ ...cell, width: '34%', padding: '14px 8px' }}>回包装登记：空瓶（　）个　箱子（　）个</td>
            </tr>
          </tbody>
        </table>

        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          货品请当面清点，如有差异请在签收时注明；标"赠"为赠品行不计价，红字行为冲销行。本单由{MERCHANT_NAME}出具。
        </Typography.Paragraph>
      </div>
    </div>
  );
}
