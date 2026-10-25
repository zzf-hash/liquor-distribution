import { useEffect, useState } from 'react';
import { Input, InputNumber, Modal, Typography } from 'antd';
import type { OrderLineDTO } from '../../services/api';

const REVERSIBLE_STATUS = new Set(['PENDING_CONFIRM', 'CONFIRMED']);

/** 原行净数量 = 原数量 + 已冲销红字（负数）。红字行本身不能再冲。 */
export function netLineQty(lines: OrderLineDTO[], line: OrderLineDTO): number {
  if (line.reversalOfId) return 0;
  const reversed = lines
    .filter((item) => item.reversalOfId === line.id)
    .reduce((sum, item) => sum + Number(item.qty), 0);
  return Number(line.qty) + reversed;
}

/** 配送前（待确认/已确认）且角色为内勤或老板，才允许发起冲销。 */
export function canReverseLine(status: string, role: string, lines: OrderLineDTO[], line: OrderLineDTO): boolean {
  if (role !== 'owner' && role !== 'clerk') return false;
  if (!REVERSIBLE_STATUS.has(status)) return false;
  return netLineQty(lines, line) > 0;
}

export function ReverseLineModal({
  open,
  productName,
  maxQty,
  onClose,
  onSubmit,
}: {
  open: boolean;
  productName: string;
  maxQty: number;
  onClose: () => void;
  onSubmit: (qty: number, reason: string) => Promise<void>;
}): JSX.Element {
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setQty(maxQty > 0 ? maxQty : null);
      setReason('');
      setError('');
    }
  }, [open, maxQty]);

  async function submit(): Promise<void> {
    if (!qty || qty <= 0 || qty > maxQty) {
      setError(`冲销数量须在 0 到 ${maxQty} 之间`);
      return;
    }
    if (!reason.trim()) {
      setError('请填写冲销原因');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(qty, reason.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="冲销订单行"
      okText="确认冲销"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => { void submit(); }}
      onCancel={onClose}
      destroyOnClose
    >
      <Typography.Paragraph>
        {productName}，最多可冲 {maxQty}
      </Typography.Paragraph>
      <InputNumber
        style={{ width: '100%', marginBottom: 12 }}
        min={0.001}
        max={maxQty}
        value={qty ?? undefined}
        onChange={(v) => setQty(typeof v === 'number' ? v : null)}
        placeholder="冲销数量"
      />
      <Input.TextArea
        rows={3}
        maxLength={200}
        value={reason}
        placeholder="冲销原因（必填）"
        onChange={(e) => setReason(e.target.value)}
      />
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
    </Modal>
  );
}
