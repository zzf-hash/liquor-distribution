interface Props {
  title: string;
  taskId: string;
}

// 未实施的菜单页。不用 antd Card，避免壳子把 Tabs 一并打进首屏。
export default function PagePlaceholder({ title, taskId }: Props): JSX.Element {
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p>模块状态：路由占位</p>
      <p>对应任务：{taskId}</p>
      <p>本模块已挂上菜单，业务页面按计划书排期实施。</p>
    </div>
  );
}
