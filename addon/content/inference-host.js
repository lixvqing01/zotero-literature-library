(() => {
  const bridgeToken = decodeURIComponent(window.location.hash.slice(1));
  const send = data => window.parent.postMessage({ source: 'literature-inference', bridgeToken, ...data }, '*', data.cache?.body ? [data.cache.body] : []);
  try {
  const worker = new Worker('inference-worker.js');
  window.addEventListener('unload', () => worker.terminate(), { once: true });
  worker.onmessage = ({ data }) => send(data);
  worker.onerror = event => send({ error: '模型 Worker 启动失败：' + (event.message || '未知错误') });
  window.addEventListener('message', ({ data, source }) => {
    if (data?.bridgeToken === bridgeToken && data?.source === 'literature-host')
      worker.postMessage(data, data.cacheResult instanceof ArrayBuffer ? [data.cacheResult] : []);
  });
  window.__literatureReady = true;
  send({ ready: true });
  } catch(e) {
    send({ error: '无法启动本地推理：' + e.message });
  }
})();
