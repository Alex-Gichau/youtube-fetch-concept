const test = require('node:test');
const assert = require('node:assert/strict');

const { isYouTubeUrl, normalizeSearchQuery, isSearchInput } = require('./search-utils.js');

test('detects a YouTube playlist URL', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/playlist?list=PLabcd1234'), true);
});

test('normalizes a text search query', () => {
  assert.equal(normalizeSearchQuery('  The Weeknd  new song  '), 'The Weeknd new song');
});

test('treats a non-URL as a search query', () => {
  assert.equal(isSearchInput('The Weeknd new song'), true);
  assert.equal(isSearchInput('https://www.youtube.com/watch?v=dUVs5Ocou8I'), false);
});
