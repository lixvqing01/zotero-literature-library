export function validateSearch(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('检索参数必须为对象。');
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > 4000) throw Error('query 长度必须为 1–4000 字符。');
  const layer = input.layer || 'auto', mode = input.mode || 'keyword';
  if (!['auto', 'metadata', 'abstract', 'fulltext'].includes(layer)) throw Error('无效检索层。');
  if (!['keyword', 'hybrid', 'semantic'].includes(mode)) throw Error('无效检索模式。');
  if (input.granularity && !['papers', 'passages'].includes(input.granularity)) throw Error('无效 granularity。');
  if (input.operator && !['AND', 'OR'].includes(input.operator)) throw Error('operator 只能是 AND 或 OR。');
  for (const field of ['query_id', 'theme_id']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 100)) throw Error(`无效 ${field}。`);
  const array = (value: any, max: number, name: string, length = 200) => {
    if (value !== undefined && (!Array.isArray(value) || value.length > max || value.some((s: any) => typeof s !== 'string' || !s.trim() || s.length > length))) throw Error(`${name} 必须为最多 ${max} 个字符串的数组。`);
  };
  for (const container of ['scope', 'filters', 'boolean']) if (input[container] !== undefined && (!input[container] || typeof input[container] !== 'object' || Array.isArray(input[container]))) throw Error(`${container} 必须为对象。`);
  for (const field of ['document_ids', 'exclude_document_ids']) array(input.scope?.[field], 3000, field);
  array(input.scope?.statuses, 4, 'statuses');
  if (input.scope?.statuses?.some((s: string) => !['unreviewed', 'included', 'excluded', 'uncertain'].includes(s))) throw Error('无效候选筛选状态。');
  for (const field of ['workspace_id', 'theme_id']) if (input.scope?.[field] !== undefined && (typeof input.scope[field] !== 'string' || input.scope[field].length > 100)) throw Error(`无效 ${field}。`);
  if (input.scope?.theme_id && !input.scope.workspace_id) throw Error('theme_id 需要 workspace_id。');
  const filters = { ...input, ...input.filters };
  for (const field of ['tags', 'collection_keys']) array(filters[field], 100, field);
  for (const field of ['library_id', 'year_from', 'year_to']) if (filters[field] !== undefined && (!Number.isInteger(filters[field]) || filters[field] < 0)) throw Error(`无效 ${field}。`);
  if (filters.year_from !== undefined && filters.year_to !== undefined && filters.year_from > filters.year_to) throw Error('年份范围起点不能晚于终点。');
  for (const field of ['author', 'publication', 'year']) if (filters[field] !== undefined && (typeof filters[field] !== 'string' || filters[field].length > 500)) throw Error(`无效 ${field}。`);
  for (const field of ['all', 'any', 'not', 'phrases']) array(input.boolean?.[field], 20, field, 300);
  array(input.section_roles, 10, 'section_roles');
  if (input.section_roles?.some((s: string) => !['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusions', 'references', 'unknown'].includes(s))) throw Error('无效章节角色。');
  for (const [field, min, max] of [['top_k', 1, 100], ['max_chars', 2000, 60000], ['snippet_chars', 0, 1200]] as const)
    if (input[field] !== undefined && (!Number.isInteger(input[field]) || input[field] < min || input[field] > max)) throw Error(`${field} 范围为 ${min}–${max}。`);
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 200)) throw Error('无效 cursor。');
  if (input.include_references !== undefined && typeof input.include_references !== 'boolean') throw Error('include_references 必须为布尔值。');
  return { ...input, query, layer, mode };
}
