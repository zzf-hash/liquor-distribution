import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { TelemetryModule } from './common/telemetry.controller';
import { TelemetryInterceptor } from './common/telemetry.interceptor';
import { NotifyModule } from './common/notify.module';
import { PrismaService } from './prisma/prisma.service';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard } from './common/auth.guard';
import { RolesGuard } from './common/roles.guard';
import { ResponseInterceptor } from './common/response.interceptor';
import { AuditModule } from './audit/audit.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ReceivablesModule } from './modules/receivables/receivables.module';
import { UsersModule } from './modules/users/users.controller';
import { HealthModule } from './modules/health/health.controller';
import { ImportsModule } from './modules/imports/imports.controller';
import { ProductsModule } from './modules/products/products.module';
import { CustomersModule } from './modules/customers/customers.module';
import { PricesModule } from './modules/prices/prices.module';
import { DashboardModule } from './modules/dashboard/dashboard.controller';
import { ApprovalsModule } from './modules/approvals/approvals.controller';
import { SpecialOrdersModule } from './modules/special-orders/special-orders.controller';
import { ReturnsModule } from './modules/returns/returns.controller';
import { PriceChangesModule } from './modules/price-changes/price-changes.controller';
import { PackagesModule } from './modules/packages/packages.controller';
import { PurchasesModule } from './modules/purchases/purchases.controller';
import { StocktakesModule } from './modules/stocktakes/stocktakes.controller';
import { RebatesModule } from './modules/rebates/rebates.controller';
import { PerformanceModule } from './modules/performance/performance.controller';
import { StatementsModule } from './modules/statements/statements.controller';
import { ReportsModule } from './modules/reports/reports.controller';
import { VisitsModule } from './modules/visits/visits.controller';
import { DraftsModule } from './modules/drafts/drafts.controller';
import { ShopModule } from './modules/shop/shop.controller';
import { StockAlertModule } from './modules/stock-alert/stock-alert.controller';

@Module({
  imports: [
    PrismaModule,
    NotifyModule,
    AuthModule,
    AuditModule,
    ProductsModule, // L3 子agent 交付
    CustomersModule, // L3 子agent 交付
    PricesModule, // L3 子agent 交付
    OrdersModule,
    ReceivablesModule,
    DashboardModule,
    ShopModule,
    ApprovalsModule,
    SpecialOrdersModule,
    ReturnsModule,
    PriceChangesModule,
    PackagesModule,
    PurchasesModule,
    StocktakesModule,
    RebatesModule,
    PerformanceModule,
    StatementsModule,
    ReportsModule,
    VisitsModule,
    DraftsModule,
    ImportsModule,
    UsersModule,
    HealthModule,
    StockAlertModule,
    TelemetryModule, // 内建遥测: 请求埋点 + 三端错误上报
  ],
  providers: [
    PrismaService,
    // 全局守卫链: 认证(B1+租户上下文) → 角色守卫(P0-02 RBAC)
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor }, // 请求遥测(先于 Response 包装, 记原始耗时)
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
