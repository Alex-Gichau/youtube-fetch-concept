/**
 * Pure helpers for slicing a list into pages.
 *
 * Pagination is done on the client: the playlist and search endpoints already
 * return every item, so there is no need to ask YouTube for one page at a
 * time. These helpers are shared by the UI and by the unit tests.
 */

/** Rows shown per page. The first option is the minimum the UI allows. */
const PAGE_SIZE_OPTIONS = [10, 20, 50];

/** The default number of rows per page. */
const DEFAULT_PAGE_SIZE = 10;

/**
 * Clamp a page number into the range that actually exists.
 * A non-numeric or out-of-range value falls back to the first page.
 */
function clampPage(page, pageCount) {
  const total = Math.max(1, Math.floor(Number(pageCount) || 1));
  const value = Math.floor(Number(page) || 1);
  return Math.min(Math.max(1, value), total);
}

/**
 * Split `items` into one page.
 *
 * @param {Array} items      the full list
 * @param {number} page      1-based page number (clamped into range)
 * @param {number} pageSize  rows per page (minimum 1)
 * @returns {{items: Array, page: number, pageSize: number, pageCount: number,
 *   total: number, hasPrev: boolean, hasNext: boolean, from: number, to: number}}
 */
function paginate(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || DEFAULT_PAGE_SIZE));
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = clampPage(page, pageCount);
  const start = (current - 1) * size;
  const slice = list.slice(start, start + size);

  return {
    items: slice,
    page: current,
    pageSize: size,
    pageCount,
    total,
    hasPrev: current > 1,
    hasNext: current < pageCount,
    /** 1-based index of the first row on this page (0 when the list is empty). */
    from: total ? start + 1 : 0,
    /** 1-based index of the last row on this page (0 when the list is empty). */
    to: start + slice.length,
  };
}

/**
 * Build the page-number strip: always the first and last page, the current
 * page and its neighbours, with `…` marking the gaps.
 *
 * @param {number} currentPage
 * @param {number} pageCount
 * @param {number} siblings  how many pages to show either side of the current
 * @returns {Array<number|string>} page numbers and `…` markers
 */
function buildPageList(currentPage, pageCount, siblings = 1) {
  const total = Math.floor(Number(pageCount) || 0);
  if (total <= 1) return [];

  const current = clampPage(currentPage, total);
  const pages = new Set([1, total]);

  for (let page = current - siblings; page <= current + siblings; page += 1) {
    if (page >= 1 && page <= total) pages.add(page);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  let previous = 0;

  for (const page of sorted) {
    if (previous && page - previous > 1) result.push('…');
    result.push(page);
    previous = page;
  }

  return result;
}

module.exports = {
  PAGE_SIZE_OPTIONS,
  DEFAULT_PAGE_SIZE,
  paginate,
  buildPageList,
  clampPage,
};
