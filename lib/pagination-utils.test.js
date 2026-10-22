const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAGE_SIZE_OPTIONS,
  DEFAULT_PAGE_SIZE,
  paginate,
  buildPageList,
  clampPage,
} = require('./pagination-utils.js');

const makeItems = (count) => Array.from({ length: count }, (_, i) => i + 1);

test('the page size options all have at least 10 rows', () => {
  assert.ok(PAGE_SIZE_OPTIONS.length > 0);
  for (const size of PAGE_SIZE_OPTIONS) {
    assert.ok(size >= 10, `expected ${size} to be at least 10`);
  }
});

test('the default page size is at least 10', () => {
  assert.ok(DEFAULT_PAGE_SIZE >= 10);
});

test('paginate splits a list into pages of the requested size', () => {
  const result = paginate(makeItems(25), 1, 10);

  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 10);
  assert.equal(result.pageCount, 3);
  assert.equal(result.total, 25);
  assert.equal(result.items.length, 10);
  assert.equal(result.items[0], 1);
  assert.equal(result.from, 1);
  assert.equal(result.to, 10);
  assert.equal(result.hasPrev, false);
  assert.equal(result.hasNext, true);
});

test('paginate returns the correct slice for later pages', () => {
  const second = paginate(makeItems(25), 2, 10);
  assert.deepEqual(second.items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(second.from, 11);
  assert.equal(second.to, 20);
  assert.equal(second.hasPrev, true);
  assert.equal(second.hasNext, true);

  const third = paginate(makeItems(25), 3, 10);
  assert.deepEqual(third.items, [21, 22, 23, 24, 25]);
  assert.equal(third.from, 21);
  assert.equal(third.to, 25);
  assert.equal(third.hasNext, false);
});

test('paginate clamps a page number that is out of range', () => {
  assert.equal(paginate(makeItems(25), 99, 10).page, 3);
  assert.equal(paginate(makeItems(25), 0, 10).page, 1);
  assert.equal(paginate(makeItems(25), -4, 10).page, 1);
  assert.equal(paginate(makeItems(25), 'nonsense', 10).page, 1);
});

test('paginate handles an empty or missing list', () => {
  const empty = paginate([], 1, 10);

  assert.equal(empty.items.length, 0);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.from, 0);
  assert.equal(empty.to, 0);
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);

  assert.equal(paginate(undefined, 1, 10).total, 0);
});

test('paginate treats a list shorter than one page as a single page', () => {
  const result = paginate(makeItems(4), 1, 10);

  assert.equal(result.pageCount, 1);
  assert.equal(result.items.length, 4);
  assert.equal(result.hasNext, false);
});

test('paginate never shows an empty page when the size changes', () => {
  const result = paginate(makeItems(25), 2, 20);

  assert.equal(result.pageCount, 2);
  assert.equal(result.items.length, 5);
  assert.equal(result.from, 21);
  assert.equal(result.to, 25);
});

test('buildPageList keeps the first, last and current pages', () => {
  assert.deepEqual(buildPageList(1, 5), [1, 2, '…', 5]);
  assert.deepEqual(buildPageList(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(buildPageList(5, 5), [1, '…', 4, 5]);
});

test('buildPageList marks the gap when pages are skipped', () => {
  assert.deepEqual(buildPageList(3, 8), [1, 2, 3, 4, '…', 8]);
  assert.deepEqual(buildPageList(6, 10), [1, '…', 5, 6, 7, '…', 10]);
});

test('buildPageList collapses a gap of one page', () => {
  assert.deepEqual(buildPageList(4, 6), [1, '…', 3, 4, 5, 6]);
});

test('buildPageList returns nothing for a single page', () => {
  assert.deepEqual(buildPageList(1, 1), []);
  assert.deepEqual(buildPageList(1, 0), []);
});

test('clampPage keeps the page inside the available range', () => {
  assert.equal(clampPage(3, 5), 3);
  assert.equal(clampPage(9, 5), 5);
  assert.equal(clampPage(0, 5), 1);
});
