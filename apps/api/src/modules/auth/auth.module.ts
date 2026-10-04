import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        // fail-fast(2026-10 审查修复): 原实现缺失时静默回退硬编码 'dev-only-secret',
        // 知道该常量者可自签任意租户 OWNER token; 现在缺失/过弱直接拒绝启动
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 16) {
          throw new Error('JWT_SECRET 未配置或长度不足 16 位, 拒绝启动(防回退公开常量被伪造 token)');
        }
        return { secret, signOptions: { expiresIn: '8h' } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
