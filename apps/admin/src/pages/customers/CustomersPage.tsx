import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Typography } from 'antd';
import { CustomersPanel } from './CustomersPanel';

export default function CustomersPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const startCreate = params.get('create') === '1';
  useEffect(() => {
    if (startCreate) setParams({}, { replace: true });
  }, [startCreate, setParams]);

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>客户管理</Typography.Title>
      <Typography.Paragraph type="secondary">
        给新店建档，或按店名、编码、手机查找已有客户。
      </Typography.Paragraph>
      <CustomersPanel prominentCreate startCreate={startCreate} />
    </div>
  );
}
