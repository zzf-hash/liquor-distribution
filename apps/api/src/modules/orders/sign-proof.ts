import { BadRequestException } from '@nestjs/common';
import { isNonEmpty } from '@liquor/shared';

export interface SignProofInput {
  type?: string;
  signatureData?: unknown;
  photoUrl?: unknown;
}

/**
 * 按签收类型要求凭证。电子签必须有签名；纸单与拍照必须有照片。
 * 空白字符串视为缺失。未知 type 不在这里拒绝（枚举校验负责）。
 * 返回 null 表示该类型的凭证已齐。
 */
export function signProofMessage(body: SignProofInput): string | null {
  if (body.type === 'E_SIGN' && !isNonEmpty(body.signatureData)) return '电子签收必须提交签名';
  if (body.type === 'PAPER' && !isNonEmpty(body.photoUrl)) return '纸质单签收必须提交照片';
  if (body.type === 'PHOTO' && !isNonEmpty(body.photoUrl)) return '拍照签收必须提交照片';
  return null;
}

export function assertSignProof(body: SignProofInput): void {
  const message = signProofMessage(body);
  if (message) throw new BadRequestException(message);
}
