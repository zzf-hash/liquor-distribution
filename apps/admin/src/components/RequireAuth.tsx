import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { getAuth } from '../services/auth';

// 路由守卫：未登录一律回登录页
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const auth = getAuth();
  if (!auth || !auth.token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
