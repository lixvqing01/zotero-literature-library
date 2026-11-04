(() => {
  const bridgeToken = decodeURIComponent(window.location.hash.slice(1));
  const send = data => window.parent.postMessage({ source: 'literature-search', bridgeToken, ...data }, '*');
  try {
    const worker = new Worker('search-worker.js');
    window.addEventListener('unload', () => worker.terminate(), { once: true });
    worker.onmessage = ({ data }) => send(data);
    worker.onerror = event => send({ fatal: event.message || '检索 Worker 启动失败' });
    window.addEventListener('message', ({ data }) => {
      if (data?.source === 'literature-search-host' && data.bridgeToken === bridgeToken) worker.postMessage(data);
    });
    send({ ready: true });
  } catch (error) { send({ fatal: error.message }); }
})();
