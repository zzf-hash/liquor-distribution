import { Navigate, Route, Routes, Link, useLocation, useNavigate } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import type { MenuDataItem } from '@ant-design/pro-components';
import {
  ProfileOutlined, DatabaseOutlined, AccountBookOutlined, BarChartOutlined,
  SettingOutlined, LogoutOutlined, AuditOutlined, GoldOutlined, RollbackOutlined,
  RiseOutlined, InboxOutlined, ShoppingCartOutlined, ReconciliationOutlined,
  GiftOutlined, MoneyCollectOutlined, FileSyncOutlined, AudioOutlined,
  AlertOutlined, PayCircleOutlined,
} from '@ant-design/icons';
import { Button, Result } from 'antd';
import type { ReactNode } from 'react';
import LoginPage from './pages/LoginPage';
import PagePlaceholder from './pages/PagePlaceholder';
import SettingsPage from './pages/settings/SettingsPage';
import OrdersPage from './pages/orders/OrdersPage';
import DeliveryNotePrint from './pages/orders/DeliveryNotePrint';
import ApprovalsPage from './pages/approvals/ApprovalsPage';
import SpecialOrdersPage from './pages/special-orders/SpecialOrdersPage';
import DraftsPage from './pages/drafts/DraftsPage';
import ReturnsPage from './pages/returns/ReturnsPage';
import PriceChangesPage from './pages/price-changes/PriceChangesPage';
import PackagesPage from './pages/packages/PackagesPage';
import PurchasesPage from './pages/purchases/PurchasesPage';
import StocktakesPage from './pages/stocktakes/StocktakesPage';
import RebatesPage from './pages/rebates/RebatesPage';
import ExpensesPage from './pages/expenses/ExpensesPage';
import PayrollPage from './pages/payroll/PayrollPage';
import MasterDataPage from './pages/master-data/MasterDataPage';
import ReceivablesPage from './pages/receivables/ReceivablesPage';
import StatementsPage from './pages/statements/StatementsPage';
import ReportsPage from './pages/reports/ReportsPage';
import StockAlertPage from './pages/stock-alert/StockAlertPage';
import { ROLE_LABELS, routesForRole, shellEntry } from './constants/roles';
import { getAuth, clearAuth } from './services/auth';
import { RequireAuth } from './components/RequireAuth';

const ICONS: Record<string, ReactNode> = {
  ProfileOutlined: <ProfileOutlined />,
  AuditOutlined: <AuditOutlined />,
  GoldOutlined: <GoldOutlined />,
  RollbackOutlined: <RollbackOutlined />,
  RiseOutlined: <RiseOutlined />,
  InboxOutlined: <InboxOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  AccountBookOutlined: <AccountBookOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  SettingOutlined: <SettingOutlined />,
  ReconciliationOutlined: <ReconciliationOutlined />,
  GiftOutlined: <GiftOutlined />,
  MoneyCollectOutlined: <MoneyCollectOutlined />,
  FileSyncOutlined: <FileSyncOutlined />,
  AudioOutlined: <AudioOutlined />,
  PayCircleOutlined: <PayCircleOutlined />,
  AlertOutlined: <AlertOutlined />,
};

// 业务页面已实施的模块；/settings 仍为路由占位
const PAGE_BY_PATH: Record<string, JSX.Element> = {
  '/orders': <OrdersPage />,
  '/approvals': <ApprovalsPage />,
  '/special-orders': <SpecialOrdersPage />,
  '/drafts': <DraftsPage />,
  '/returns': <ReturnsPage />,
  '/price-changes': <PriceChangesPage />,
  '/packages': <PackagesPage />,
  '/purchases': <PurchasesPage />,
  '/stocktakes': <StocktakesPage />,
  '/rebates': <RebatesPage />,
  '/expenses': <ExpensesPage />,
  '/payroll': <PayrollPage />,
  '/master-data': <MasterDataPage />,
  '/receivables': <ReceivablesPage />,
  '/statements': <StatementsPage />,
  '/reports': <ReportsPage />,
  '/stock-alert': <StockAlertPage />,
  '/settings': <SettingsPage />,
};

function Shell(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const auth = getAuth();
  const entry = shellEntry(auth?.role);
  if (entry.kind === 'login') {
    clearAuth();
    return <Navigate to="/login" replace />;
  }
  const role = auth?.role ?? '';

  // 菜单按角色显隐。首页落到第一项可见路由，不再写死订单池。
  const visibleRoutes = routesForRole(role);
  const menuData: MenuDataItem[] = visibleRoutes.map((r) => ({
    path: r.path,
    name: r.name,
    icon: ICONS[r.icon],
  }));

  function logout(): void {
    clearAuth();
    navigate('/login', { replace: true });
  }

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
        title: `${auth?.name ?? ''}（${ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}）`,
        size: 'small',
        render: (_props, dom) => (
          <Button type="text" icon={<LogoutOutlined />} onClick={logout}>
            {dom}
          </Button>
        ),
      }}
    >
      <Routes>
        {entry.kind === 'home' ? <Route path="/" element={<Navigate to={entry.path} replace />} /> : null}
        {visibleRoutes.map((r) => (
          <Route
            key={r.path}
            path={`${r.path}/*`}
            element={PAGE_BY_PATH[r.path] ?? <PagePlaceholder title={r.name} taskId={r.taskId} />}
          />
        ))}
        <Route
          path="*"
          element={entry.kind === 'denied' ? (
            <Result
              status="403"
              title="该账号无后台权限"
              extra={<Button type="primary" onClick={logout}>退出登录</Button>}
            />
          ) : (
            <Result status="404" title="404" subTitle="页面不存在" />
          )}
        />
      </Routes>
    </ProLayout>
  );
}

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* 送货单套打页（P0-T24）：独立于 ProLayout 外的 A4 纸面，新窗口打开 */}
      <Route
        path="/orders/:id/print"
        element={
          <RequireAuth>
            <DeliveryNotePrint />
          </RequireAuth>
        }
      />
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
