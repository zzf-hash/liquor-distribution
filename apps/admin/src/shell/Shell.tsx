import { Component, lazy, Suspense } from 'react';
import type { ErrorInfo, LazyExoticComponent, ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  ProfileOutlined, DatabaseOutlined, AccountBookOutlined, BarChartOutlined,
  SettingOutlined, LogoutOutlined, AuditOutlined, GoldOutlined, RollbackOutlined,
  RiseOutlined, InboxOutlined, ShoppingCartOutlined, ReconciliationOutlined,
  GiftOutlined, MoneyCollectOutlined, FileSyncOutlined, AudioOutlined,
  AlertOutlined, PayCircleOutlined, TeamOutlined,
} from '@ant-design/icons';
import { Button } from 'antd';
import { ROLE_LABELS, routesForRole, shellEntry } from '../constants/roles';
import { getAuth, clearAuth } from '../services/auth';
import PagePlaceholder from '../pages/PagePlaceholder';

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
  TeamOutlined: <TeamOutlined />,
};

// 每个菜单页单独 chunk。壳子只保留动态 import，不把页面打进登录包。
const PAGES: Record<string, LazyExoticComponent<() => JSX.Element>> = {
  '/orders': lazy(() => import('../pages/orders/OrdersPage')),
  '/customers': lazy(() => import('../pages/customers/CustomersPage')),
  '/approvals': lazy(() => import('../pages/approvals/ApprovalsPage')),
  '/special-orders': lazy(() => import('../pages/special-orders/SpecialOrdersPage')),
  '/drafts': lazy(() => import('../pages/drafts/DraftsPage')),
  '/returns': lazy(() => import('../pages/returns/ReturnsPage')),
  '/price-changes': lazy(() => import('../pages/price-changes/PriceChangesPage')),
  '/packages': lazy(() => import('../pages/packages/PackagesPage')),
  '/purchases': lazy(() => import('../pages/purchases/PurchasesPage')),
  '/stocktakes': lazy(() => import('../pages/stocktakes/StocktakesPage')),
  '/rebates': lazy(() => import('../pages/rebates/RebatesPage')),
  '/expenses': lazy(() => import('../pages/expenses/ExpensesPage')),
  '/payroll': lazy(() => import('../pages/payroll/PayrollPage')),
  '/master-data': lazy(() => import('../pages/master-data/MasterDataPage')),
  '/receivables': lazy(() => import('../pages/receivables/ReceivablesPage')),
  '/statements': lazy(() => import('../pages/statements/StatementsPage')),
  '/reports': lazy(() => import('../pages/reports/ReportsPage')),
  '/stock-alert': lazy(() => import('../pages/stock-alert/StockAlertPage')),
  '/settings': lazy(() => import('../pages/settings/SettingsPage')),
};

class PageBoundary extends Component<{ path: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidUpdate(prev: { path: string }): void {
    if (prev.path !== this.props.path && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <div style={{ padding: 24 }}>页面打开失败：{this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

function PageSlot({ path, title, taskId }: { path: string; title: string; taskId: string }): JSX.Element {
  const Page = PAGES[path];
  if (!Page) return <PagePlaceholder title={title} taskId={taskId} />;
  return (
    <PageBoundary path={path}>
      <Suspense fallback={<div style={{ padding: 48, color: '#595959' }}>页面加载中</div>}>
        <Page />
      </Suspense>
    </PageBoundary>
  );
}

export default function Shell(): JSX.Element {
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
  const selected = visibleRoutes.find((r) => location.pathname === r.path || location.pathname.startsWith(`${r.path}/`))?.path;

  function logout(): void {
    clearAuth();
    navigate('/login', { replace: true });
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f5f5f5' }}>
      <aside style={{ width: 220, background: '#fff', borderRight: '1px solid #f0f0f0' }}>
        <div style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 16px', fontWeight: 600 }}>
          内勤后台
        </div>
        {visibleRoutes.map((r) => (
          <button
            key={r.path}
            type="button"
            onClick={() => navigate(r.path)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '10px 16px', border: 0, background: selected === r.path ? '#e6f4ff' : 'transparent',
              color: selected === r.path ? '#1677ff' : '#1f1f1f', cursor: 'pointer', textAlign: 'left',
            }}
          >
            {ICONS[r.icon]}
            {r.name}
          </button>
        ))}
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>
        <header style={{ height: 48, background: '#fff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid #f0f0f0' }}>
          <span style={{ marginRight: 8 }}>
            {auth?.name ?? ''}（{ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}）
          </span>
          <Button type="text" icon={<LogoutOutlined />} onClick={logout}>退出登录</Button>
        </header>
        <main style={{ margin: 16 }}>
      <Routes>
        {entry.kind === 'home' ? <Route path="/" element={<Navigate to={entry.path} replace />} /> : null}
        {visibleRoutes.map((r) => (
          <Route
            key={r.path}
            path={`${r.path}/*`}
            element={<PageSlot path={r.path} title={r.name} taskId={r.taskId} />}
          />
        ))}
        <Route
          path="*"
          element={entry.kind === 'denied' ? (
            <div>
              <h2>该账号无后台权限</h2>
              <Button type="primary" onClick={logout}>退出登录</Button>
            </div>
          ) : (
            <div>
              <h2>404</h2>
              <p>页面不存在</p>
            </div>
          )}
        />
      </Routes>
        </main>
      </div>
    </div>
  );
}
