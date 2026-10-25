import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { decodeNamedCharacterReferenceFile } from './markdown-worker-entities.ts';

describe('decodeNamedCharacterReferenceFile', () => {
  test('DOM を使わない index.js を指す', () => {
    assert.equal(path.basename(decodeNamedCharacterReferenceFile), 'index.js');
    assert.doesNotMatch(readFileSync(decodeNamedCharacterReferenceFile, 'utf8'), /\bdocument\b/);
  });
});
