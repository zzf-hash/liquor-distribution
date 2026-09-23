import { PageContainer } from '@ant-design/pro-components';
import { Card, Descriptions, Tag, Typography } from 'antd';

interface Props {
  title: string;
  taskId: string;
}

// P0-01b 路由占位页：标明各模块对应的计划书任务，业务页面按排期逐模块实施
export default function PagePlaceholder({ title, taskId }: Props): JSX.Element {
  return (
    <PageContainer title={title}>
      <Card>
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="模块状态">
            <Tag color="orange">路由占位</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="对应任务">{taskId}</Descriptions.Item>
          <Descriptions.Item label="说明">
            本模块由 P0-01b 完成路由与菜单挂载，业务页面按计划书排期逐个实施。
          </Descriptions.Item>
          <Descriptions.Item label="验收">
            pnpm build 通过；登录后可见本页导航（1080p 演示就绪）。
          </Descriptions.Item>
        </Descriptions>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          task 7bb5e0eb · frontend 备用Hermes-笔记本（32c4186f）
        </Typography.Paragraph>
      </Card>
    </PageContainer>
  );
}
