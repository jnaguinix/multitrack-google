(async () => {
  const probeName = 'omnitracks-poc-' + crypto.randomUUID();
  const result = {
    origin: location.origin,
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    audioContext: typeof AudioContext === 'function',
    openFilePicker: typeof window.showOpenFilePicker === 'function',
    directoryPicker: typeof window.showDirectoryPicker === 'function',
    indexedDb: null,
    opfsWorker: null,
  };

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  try {
    const open = indexedDB.open(probeName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('check');
    const db = await requestResult(open);
    try {
      const write = db.transaction('check', 'readwrite');
      const committed = new Promise((resolve, reject) => {
        write.oncomplete = resolve;
        write.onabort = () => reject(write.error);
      });
      write.objectStore('check').put(42, 'probe');
      await committed;
      const read = db.transaction('check').objectStore('check').get('probe');
      result.indexedDb = (await requestResult(read)) === 42;
    } finally {
      db.close();
      await requestResult(indexedDB.deleteDatabase(probeName));
    }
  } catch (error) {
    result.indexedDb = String(error);
  }

  const workerSource = '(' + (async function (name) {
    let root;
    let handle;
    let status;
    try {
      root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(name, { create: true });
      handle = await file.createSyncAccessHandle();
      const payload = new Uint8Array([76, 84, 42]);
      const written = handle.write(payload, { at: 0 });
      handle.flush();
      const read = new Uint8Array(3);
      status = written === 3 && handle.read(read, { at: 0 }) === 3 && read.every((value, index) => value === payload[index]);
    } catch (error) {
      status = String(error);
    } finally {
      handle?.close();
      if (root) await root.removeEntry(name).catch(() => {});
    }
    self.postMessage(status);
  }).toString() + ')(' + JSON.stringify(probeName) + ')';
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  let worker;
  try {
    worker = new Worker(workerUrl);
    result.opfsWorker = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve('Worker sin respuesta después de 5 s'), 5000);
      const finish = (value) => { clearTimeout(timeout); resolve(value); };
      worker.onmessage = (event) => finish(event.data);
      worker.onerror = (event) => finish(event.message || 'Error de Worker');
    });
  } catch (error) {
    result.opfsWorker = String(error);
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(workerUrl);
  }
  return result;
})()
