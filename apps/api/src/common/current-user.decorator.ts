import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
  tenantId: string;
  username: string;
  name: string;
  role: 'OWNER' | 'REP' | 'CLERK' | 'WAREHOUSE' | 'CUSTOMER';
  dataScope: 'ALL' | 'SELF' | 'OWN_CUSTOMERS' | 'SELF_ORDER';
  /** role=CUSTOMER 时绑定的客户档案 id(P1-5: 客户身份一律取自 token) */
  customerId?: string;
  /** staff=内勤信道 / customer=外部信道(P1-1 分离) */
  aud: 'staff' | 'customer';
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user as AuthUser;
  },
);
