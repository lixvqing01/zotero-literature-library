import { SearchEngine } from './search-engine';
const engines = new Map<string, SearchEngine>();
self.onmessage = ({ data }) => {
  try {
    let engine = engines.get(data.group);
    if (!engine) { engine = new SearchEngine(); engines.set(data.group, engine); }
    let result: any;
    if (data.action === 'apply') result = engine.apply(data.value);
    else if (data.action === 'restore') result = engine.restore(data.value);
    else if (data.action === 'dump') result = engine.dump();
    else if (data.action === 'vectors') { engine.loadVectors(data.key, data.value); result = true; }
    else if (data.action === 'search') result = engine.search(data.input, data.fingerprint, data.vector);
    else throw Error('未知检索操作');
    self.postMessage({ id: data.id, result });
  } catch (error: any) { self.postMessage({ id: data.id, error: error.detail || { code: 'SEARCH_WORKER_ERROR', message: error.message, retryable: false } }); }
};
