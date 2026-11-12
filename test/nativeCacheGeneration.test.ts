// Pruebas del flujo de caché nativa (añadir al setlist, avance real, sin decodificación doble).
// El backend Rust se simula con un invoke/listen falsos que respetan el contrato real:
// - audio_get_project_cache_status EXIGE trackIds (como el comando Rust) y responde `isReady`.
// - audio_import_tracks emite audio://import-progress por pista (track_index 0-based) y un `completed`.

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

type Handler = (payload: any) => void;
let progressHandler: Handler | null = null;
let cacheReady = false;
let importCalls = 0;
let failNextImport = false;
const statusArgs: any[] = [];

const emit = (payload: any) => progressHandler?.({ payload });
const tick = () => new Promise((r) => setTimeout(r, 5));

const fakeInvoke = async (cmd: string, args: any = {}) => {
  switch (cmd) {
    case 'audio_get_project_cache_status': {
      statusArgs.push(args);
      if (!Array.isArray(args.trackIds)) throw new Error('missing required key trackIds');
      return { isReady: cacheReady, cachedTracksCount: cacheReady ? 3 : 0, totalTracksCount: 3 };
    }
    case 'audio_check_files_exist':
      return (args.paths || []).map(() => true);
    case 'audio_import_tracks': {
      importCalls++;
      const total = args.files.length;
      if (failNextImport) {
        failNextImport = false;
        emit({ project_id: args.projectId, track_index: 0, total_tracks: total, track_name: 't', percent: 0, completed: false });
        throw new Error('disco desconectado');
      }
      for (let i = 0; i < total; i++) {
        emit({
          project_id: args.projectId,
          track_index: i,
          total_tracks: total,
          track_name: args.files[i].trackId,
          percent: (i / total) * 100,
          completed: false,
        });
        await tick();
      }
      emit({ project_id: args.projectId, track_index: total, total_tracks: total, track_name: 'Completado', percent: 100, completed: true });
      cacheReady = true;
      return { tracks: args.files.map((f: any) => ({ trackId: f.trackId })), errors: [] };
    }
    default:
      return null;
  }
};

// pcmReaderClient (importado por el motor) crea un Worker al cargarse: no existe en Node.
(globalThis as any).Worker = class {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage: unknown = null;
  onerror: unknown = null;
};

(globalThis as any).window = {
  __TAURI__: {
    core: { invoke: fakeInvoke },
    event: { listen: async (_name: string, cb: Handler) => { progressHandler = cb; return () => {}; } },
  },
  setInterval: () => 0,
  clearInterval: () => {},
};

const project: any = {
  id: 'song-1',
  title: 'Eres Bendito',
  tracks: [1, 2, 3].map((n) => ({ id: `stem-0${n}`, name: `T${n}`, filePath: `C:\\x\\t${n}.mp3` })),
};

async function main() {
  const { NativeAudioEngine } = await import('../src/audio/nativeAudioEngine');
  const engine = new NativeAudioEngine();
  await tick();
  const notices: string[] = [];
  engine.setOnNotice((m) => notices.push(m));

  console.log('=== PRUEBAS: caché nativa (setlist, progreso real, sin doble decodificación) ===');

  // 1. checkProjectCacheStatus envía trackIds y lee isReady (bug: se llamaba solo con projectId).
  let st = await engine.checkProjectCacheStatus(project);
  assert(statusArgs[0].trackIds.length === 3, 'checkProjectCacheStatus debe enviar trackIds');
  assert(st.isReady === false, 'sin caché -> isReady false');
  console.log('OK 1: estado de caché consultado con trackIds, isReady=false');

  // 2. Generar: avance real "pista N de M" y una sola decodificación.
  const seen: string[] = [];
  const ok = await engine.generateNativeCacheForProject(project, (_p, text) => seen.push(text));
  assert(ok === true, 'generate devuelve true');
  assert(importCalls === 1, `una sola importación (fueron ${importCalls})`);
  assert(seen.some((t) => t.startsWith('Pista 1 de 3')), 'muestra "Pista 1 de 3"');
  assert(seen.some((t) => t.startsWith('Pista 3 de 3')), 'muestra "Pista 3 de 3"');
  assert(engine.isProjectImporting(project.id) === false, 'al terminar ya no está importando');
  assert((await engine.checkProjectCacheStatus(project)).isReady === true, 'caché lista tras generar');
  console.log('OK 2: avance real mostrado:', seen.join(' | '));

  // 3. Quitar del setlist (caché borrada) y volver a añadir -> se regenera.
  cacheReady = false;
  assert((await engine.checkProjectCacheStatus(project)).isReady === false, 'tras borrar, no está lista');
  assert((await engine.generateNativeCacheForProject(project)) === true, 'regenera');
  assert(importCalls === 2, `regeneración = 2ª importación (fueron ${importCalls})`);
  console.log('OK 3: quitar y volver a añadir regenera la caché');

  // 4. Doble pulsación simultánea: una sola decodificación.
  cacheReady = false;
  importCalls = 0;
  const [a, b] = await Promise.all([
    engine.generateNativeCacheForProject(project),
    engine.generateNativeCacheForProject(project),
  ]);
  assert(a === true && b === true, 'ambas llamadas terminan bien');
  assert(importCalls === 1, `pulsar dos veces solo decodifica una (fueron ${importCalls})`);
  console.log('OK 4: dos llamadas simultáneas -> 1 decodificación');

  // 5. Importación ya en curso por otro camino (isProjectImporting): no lanzar otra.
  cacheReady = false;
  importCalls = 0;
  engine.markImportStarted(project.id, 'externa', 3);
  const waiting = engine.generateNativeCacheForProject(project);
  await tick();
  assert(importCalls === 0, 'no lanza importación mientras hay una en curso');
  cacheReady = true;
  emit({ project_id: project.id, track_index: 3, total_tracks: 3, track_name: 'Completado', percent: 100, completed: true });
  assert((await waiting) === true, 'al terminar la externa devuelve true sin decodificar de nuevo');
  assert(importCalls === 0, 'sigue sin decodificar');
  console.log('OK 5: con isProjectImporting no se lanza una segunda decodificación');

  // 6. Fallo: se avisa, devuelve false y no queda "importando" para siempre.
  cacheReady = false;
  failNextImport = true;
  notices.length = 0;
  assert((await engine.generateNativeCacheForProject(project)) === false, 'fallo -> false');
  assert(notices.some((n) => n.includes('disco desconectado')), 'el error se muestra al usuario (no se traga)');
  assert(engine.isProjectImporting(project.id) === false, 'tras el fallo no queda importando');
  console.log('OK 6: fallo notificado y estado limpio:', notices[0]);

  // 7. Estado síncrono de la caché nativa para pintar las tarjetas del setlist/En vivo.
  //    - null hasta que se consulta; luego true/false según el backend.
  //    - se notifica a los suscriptores solo cuando el valor cambia.
  //    - al terminar de generar queda en true sin que nadie tenga que volver a consultar.
  const p2: any = { ...project, id: 'song-2' };
  assert(engine.isNativeCacheReady(p2.id) === null, '7a: sin consulta previa -> null');
  let notified = 0;
  const unsub = engine.subscribeCache(() => notified++);

  cacheReady = false;
  await engine.checkProjectCacheStatus(p2);
  assert(engine.isNativeCacheReady(p2.id) === false, '7b: tras consultar sin caché -> false');
  assert(notified >= 1, '7b: el cambio null->false se notifica');

  assert((await engine.generateNativeCacheForProject(p2)) === true, '7c: genera');
  assert(engine.isNativeCacheReady(p2.id) === true, '7c: tras generar -> true sin consultar de nuevo');

  const antes = notified;
  await engine.checkProjectCacheStatus(p2);
  assert(notified === antes, '7d: consultar sin cambios NO notifica (evita redibujados en bucle)');

  cacheReady = false;
  await engine.checkProjectCacheStatus(p2);
  assert(engine.isNativeCacheReady(p2.id) === false, '7e: caché borrada -> false');
  assert(notified > antes, '7e: el cambio true->false se notifica');

  await engine.refreshCacheStatuses([p2, { ...project, id: 'song-3' } as any]);
  assert(engine.isNativeCacheReady('song-3') === false, '7f: refreshCacheStatuses consulta varias canciones');
  unsub();
  console.log('OK 7: estado nativo síncrono, notificación solo al cambiar, refresco múltiple');

  console.log('\nTODAS LAS PRUEBAS PASARON');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL (excepción):', e);
  process.exit(1);
});
