import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { isAdminRole } from '../constants/roles';
import { clearAuth, getAuth } from '../services/auth';

// 路由守卫：未登录或没有角色回登录页。客户账号不能进内勤后台。
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const auth = getAuth();
  if (!auth || !auth.token || !auth.role) {
    if (auth) clearAuth();
    return <Navigate to="/login" replace />;
  }
  if (!isAdminRole(auth.role)) {
    clearAuth();
    sessionStorage.setItem('ld_admin_denied', '客户账号请使用订货小程序，不能进入内勤后台');
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
