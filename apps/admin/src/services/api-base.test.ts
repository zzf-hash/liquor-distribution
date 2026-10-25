import { describe, expect, it } from 'vitest';
import { apiBase } from './api-base';

describe('apiBase', () => {
  it('uses the dev proxy when unset and appends /api only once', () => {
    expect(apiBase('')).toBe('/api');
    expect(apiBase(undefined)).toBe('/api');
    expect(apiBase('https://api.example.com')).toBe('https://api.example.com/api');
    expect(apiBase('https://api.example.com/api/')).toBe('https://api.example.com/api');
  });
});
