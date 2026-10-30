import { ApiError } from '../../services/api';

export type PreviewFailureDecision =
  | { kind: 'degrade'; message: string }
  | { kind: 'stop'; message: string };

/**
 * 收货预览失败后的动作。
 * 404：后端 PR #1 尚未部署，允许不展示批次直接确认。
 * 409 以及其他错误：停下来，把原因给用户，不能接着确认。
 */
export function decidePreviewFailure(error: unknown): PreviewFailureDecision {
  const status = error instanceof ApiError ? error.status : -1;
  const message = error instanceof Error && error.message ? error.message : '收货预览失败';
  if (status === 404) {
    return {
      kind: 'degrade',
      message: '收货预览接口尚未提供，不能展示回冲批次。确认后仍由服务端回冲库存并冲减客户欠款。',
    };
  }
  return { kind: 'stop', message };
}
