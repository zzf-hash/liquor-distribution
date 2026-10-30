import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import { RequireAuth } from './components/RequireAuth';

const Shell = lazy(() => import('./shell/Shell'));
const DeliveryNotePrint = lazy(() => import('./pages/orders/DeliveryNotePrint'));

function BootFallback(): JSX.Element {
  return <div style={{ padding: 48, color: '#595959' }}>页面加载中</div>;
}

export default function App(): JSX.Element {
  return (
    <Suspense fallback={<BootFallback />}>
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
    </Suspense>
  );
}
