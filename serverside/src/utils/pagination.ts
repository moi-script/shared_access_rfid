export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export function getPagination(query: Record<string, unknown>): PaginationParams {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export function buildMeta(total: number, page: number, limit: number) {
  return { pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}
