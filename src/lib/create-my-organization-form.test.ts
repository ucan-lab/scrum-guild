import { describe, expect, test } from 'vitest';
import type { ErrorBody } from '../shared/errors.ts';
import { createMyOrganizationFailure, validateCreateMyOrganization } from './create-my-organization-form.ts';

const failed = (status: number, code: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message: 'x', ...(details === undefined ? {} : { details }) } as ErrorBody['error'],
});

describe('validateCreateMyOrganization', () => {
  test('通る入力は誤りなし', () => {
    expect(validateCreateMyOrganization({ slug: 'sakura-dev', name: 'さくら開発' })).toBeNull();
  });

  test('slug は前後の空白を除いてから見る', () => {
    expect(validateCreateMyOrganization({ slug: '  sakura-dev ', name: 'さくら開発' })).toBeNull();
  });

  test('slug が空、形違い、予約名はそれぞれの理由で slug の欄に出す', () => {
    expect(validateCreateMyOrganization({ slug: ' ', name: 'a' })).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugRequired',
    });
    expect(validateCreateMyOrganization({ slug: 'Sakura', name: 'a' })).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugFormat',
    });
    expect(validateCreateMyOrganization({ slug: 'login', name: 'a' })).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugReserved',
    });
  });

  test('名前が空、長すぎる、不可視文字を含むときは名前の欄に出す', () => {
    expect(validateCreateMyOrganization({ slug: 'sakura-dev', name: '  ' })).toEqual({
      field: 'name',
      key: 'createMyOrganizationNameRequired',
    });
    expect(validateCreateMyOrganization({ slug: 'sakura-dev', name: 'あ'.repeat(81) })).toEqual({
      field: 'name',
      key: 'createMyOrganizationNameLong',
    });
    expect(validateCreateMyOrganization({ slug: 'sakura-dev', name: 'さくら​開発' })).toEqual({
      field: 'name',
      key: 'createMyOrganizationNameInvalid',
    });
  });

  test('名前が80字ちょうどなら通る', () => {
    expect(validateCreateMyOrganization({ slug: 'sakura-dev', name: 'あ'.repeat(80) })).toBeNull();
  });
});

describe('createMyOrganizationFailure', () => {
  test('409 の slug_taken は slug の欄、trial_limit は枠に出す', () => {
    expect(createMyOrganizationFailure(failed(409, 'conflict', { reason: 'slug_taken' }))).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugTaken',
    });
    expect(createMyOrganizationFailure(failed(409, 'conflict', { reason: 'trial_limit' }))).toEqual({
      field: 'form',
      key: 'createMyOrganizationTrialLimit',
    });
  });

  test('400 は details の path で欄を決める', () => {
    expect(
      createMyOrganizationFailure(failed(400, 'invalid_input', [{ path: 'slug', code: 'slug_reserved' }])),
    ).toEqual({ field: 'slug', key: 'createMyOrganizationSlugReserved' });
    expect(createMyOrganizationFailure(failed(400, 'invalid_input', [{ path: 'slug', code: 'slug_format' }]))).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugFormat',
    });
    expect(createMyOrganizationFailure(failed(400, 'invalid_input', [{ path: 'name', code: 'custom' }]))).toEqual({
      field: 'name',
      key: 'createMyOrganizationNameInvalid',
    });
    expect(createMyOrganizationFailure(failed(400, 'invalid_input', [{ path: 'other' }]))).toEqual({
      field: 'form',
      key: 'createMyOrganizationInvalid',
    });
    expect(createMyOrganizationFailure(failed(400, 'invalid_input'))).toEqual({
      field: 'form',
      key: 'createMyOrganizationInvalid',
    });
  });

  test('429 は「しばらくしてから」の文言、ほかは作れなかった文言', () => {
    expect(createMyOrganizationFailure(failed(429, 'rate_limited'))).toEqual({
      field: 'form',
      key: 'createMyOrganizationRateLimited',
    });
    expect(createMyOrganizationFailure(failed(503, 'unavailable'))).toEqual({
      field: 'form',
      key: 'createMyOrganizationFailed',
    });
    expect(createMyOrganizationFailure({ ok: false, status: 0, error: null })).toEqual({
      field: 'form',
      key: 'createMyOrganizationFailed',
    });
  });
});
