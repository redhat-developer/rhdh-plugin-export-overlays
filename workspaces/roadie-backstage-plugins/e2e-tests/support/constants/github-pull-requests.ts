export const TABLE_SELECTORS = {
  nextPage: 'button[aria-label="Next Page"]',
  previousPage: 'button[aria-label="Previous Page"]',
  lastPage: 'button[aria-label="Last Page"]',
  rows: 'table[class*="MuiTable-root-"] tbody tr',
  pageSelectBox: 'div[class*="MuiTablePagination-input"]',
} as const;
