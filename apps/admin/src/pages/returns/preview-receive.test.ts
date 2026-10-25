import { describe, expect, it } from 'vitest';
import { ApiError } from '../../services/api';
import { decidePreviewFailure } from './preview-receive';

describe('return receive preview', () => {
  it('stops on 409 and keeps the server message', () => {
    const error = new ApiError('退货审批通过后才可收货回冲', 409, 409, null);
    expect(decidePreviewFailure(error)).toEqual({
      kind: 'stop',
      message: '退货审批通过后才可收货回冲',
    });
  });

  it('degrades only when the preview route is missing', () => {
    const error = new ApiError('Cannot GET /api/returns/x/preview-receive', 404, 404, null);
    expect(decidePreviewFailure(error).kind).toBe('degrade');
  });

  it('does not confirm when the preview request fails for another reason', () => {
    expect(decidePreviewFailure(new ApiError('网络连接失败', -1, -1, null)).kind).toBe('stop');
    expect(decidePreviewFailure(new Error('boom')).kind).toBe('stop');
  });
});
