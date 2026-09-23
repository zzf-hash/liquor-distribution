import { Navigate, Route, Routes, Link, useLocation, useNavigate } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import type { MenuDataItem } from '@ant-design/pro-components';
import {
  ProfileOutlined, DatabaseOutlined, AccountBookOutlined, BarChartOutlined,
  SettingOutlined, LogoutOutlined,
} from '@ant-design/icons';
import { Button, Result } from 'antd';
import type { ReactNode } from 'react';
import LoginPage from './pages/LoginPage';
import PagePlaceholder from './pages/PagePlaceholder';
import { ADMIN_ROUTES, MENU_ROLES } from './constants/roles';
import { getAuth, clearAuth } from './services/auth';
import type { Role } from './constants/roles';
import { RequireAuth } from './components/RequireAuth';

const ICONS: Record<string, ReactNode> = {
  ProfileOutlined: <ProfileOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  AccountBookOutlined: <AccountBookOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  SettingOutlined: <SettingOutlined />,
};

function Shell(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const auth = getAuth();
  const role: Role = auth?.role ?? 'admin';

  // 菜单按角色显隐（§2.1 各岗位只看自己的一屏）
  const visibleRoutes = ADMIN_ROUTES.filter((r) => (MENU_ROLES[r.path] ?? []).includes(role));
  const menuData: MenuDataItem[] = visibleRoutes.map((r) => ({
    path: r.path,
    name: r.name,
    icon: ICONS[r.icon],
  }));

  return (
    <ProLayout
      title="内勤后台"
      logo={null}
      layout="mix"
      fixSiderbar
      location={{ pathname: location.pathname }}
      menu={{ request: async () => menuData }}
      menuItemRender={(item, dom) =>
        item.path ? <Link to={item.path}>{dom}</Link> : dom
      }
      avatarProps={{
        title: `${auth?.name ?? ''}（${role}）`,
        size: 'small',
        render: (_props, dom) => (
          <Button
            type="text"
            icon={<LogoutOutlined />}
            onClick={() => {
              clearAuth();
              navigate('/login', { replace: true });
            }}
          >
            {dom}
          </Button>
        ),
      }}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/orders" replace />} />
        {visibleRoutes.map((r) => (
          <Route
            key={r.path}
            path={`${r.path}/*`}
            element={<PagePlaceholder title={r.name} taskId={r.taskId} />}
          />
        ))}
        <Route
          path="*"
          element={<Result status="404" title="404" subTitle="页面不存在" />}
        />
      </Routes>
    </ProLayout>
  );
}

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
