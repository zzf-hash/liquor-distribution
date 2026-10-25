import { getMetadataStorage, ValidationError } from 'class-validator';

/** 把校验器里的枚举（数组或 TS enum）收成允许值列表。 */
export function enumValuesOf(entity: unknown): string[] {
  if (Array.isArray(entity)) return entity.map((v) => String(v));
  if (entity && typeof entity === 'object') {
    const values = Object.values(entity as Record<string, unknown>);
    const names = values.filter((v) => typeof v === 'string').map((v) => String(v));
    return names.length > 0 ? [...new Set(names)] : values.map((v) => String(v));
  }
  return [];
}

function allowedEnum(target: object, property: string): string[] {
  const ctor = target.constructor as new (...args: unknown[]) => object;
  const metas = getMetadataStorage().getTargetValidationMetadatas(ctor, ctor.name, true, false);
  const meta = metas.find((m) => m.propertyName === property && m.name === 'isEnum');
  if (!meta?.constraints?.length) return [];
  return enumValuesOf(meta.constraints[0]);
}

/**
 * class-validator 的默认文案里枚举值在数组 replace 时可能被吃掉，
 * 这里按元数据把允许值写回去。多条消息由过滤器用「；」拼接，避免逗号把枚举列表和下一句粘在一起。
 */
export function formatValidationErrors(errors: ValidationError[]): string[] {
  const lines: string[] = [];
  const walk = (list: ValidationError[]): void => {
    for (const err of list) {
      if (err.constraints) {
        for (const [name, raw] of Object.entries(err.constraints)) {
          if (name === 'isEnum' && err.target) {
            const allowed = allowedEnum(err.target, err.property);
            if (allowed.length > 0) {
              lines.push(`${err.property} must be one of the following values: ${allowed.join(', ')}`);
              continue;
            }
          }
          const text = typeof raw === 'string' ? raw : String(raw);
          lines.push(text);
        }
      }
      if (err.children?.length) walk(err.children);
    }
  };
  walk(errors);
  return lines;
}

/** HttpException body.message 可能是字符串或字符串数组。数组用「；」接，保留每条里的逗号。 */
export function joinExceptionMessage(message: unknown, fallback: string): string {
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message)) {
    const parts = message
      .map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (parts.length > 0) return parts.join('；');
  }
  return fallback;
}
