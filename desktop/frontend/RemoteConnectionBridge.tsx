
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Radio } from 'lucide-react';
import type { SongProject } from '../../src/types/project';
import { audioEngine } from '../../src/audio/audioEngine';
import { applyMix, matches, snapshot, targets, trackIdentity } from './remoteState';
import type { Clock, Dispatch, Receipt, Source } from './remoteState';
import DesktopUpdates from './DesktopUpdates';
import './connection.css';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Role = 'monitor' | 'mixer';
type Device = { id: number; role: Role; address: string };
type Pairing = { role: Role; url: string; qr: string };
type Connection = { epoch: string; devices: Device[]; pairings: Pairing[] };
type Status = { interfaces: { name: string; address: string }[]; connection: Connection | null; updatesEnabled: boolean };
type Exchange = { commands: Dispatch[]; devices: Device[] };
type Props = Pick<Source, 'project' | 'setlist'> & {
  triggerHost: HTMLElement | null;
  activationCount: Readonly<RefObject<number>>;
  updateProject: (update: (previous: SongProject) => SongProject) => void;
};

const host = window as Window & { __TAURI__?: { core: { invoke: Invoke } } };
const invoke = host.__TAURI__?.core.invoke;
const EXCHANGE_MS = 100;
const COMMIT_TIMEOUT_MS = 600;
const roleName: Record<Role, string> = { monitor: 'Músicos', mixer: 'Sonidista' };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sameDevices(left: Device[], right: Device[]) {
  return left.length === right.length && left.every((device, index) =>
    device.id === right[index].id && device.role === right[index].role && device.address === right[index].address);
}

export default memo(function RemoteConnectionBridge({ project, setlist, activationCount, updateProject, triggerHost }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const source = useRef({ project, setlist });
  const epoch = useRef<string | null>(null);
  const revision = useRef({ value: 0, identity: '' });
  const [connection, setConnection] = useState<Connection | null>(null);
  const [interfaces, setInterfaces] = useState<Status['interfaces']>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [updatesEnabled, setUpdatesEnabled] = useState(false);

  useLayoutEffect(() => {
    source.current = { project, setlist };
    if (!epoch.current) return;
    const identity = trackIdentity(project);
    if (identity !== revision.current.identity) {
      revision.current = { identity, value: revision.current.value + 1 };
    }
  }, [project, setlist]);

  function setRemoteConnection(next: Connection | null) {
    if (next && epoch.current !== next.epoch) {
      revision.current = { value: 1, identity: trackIdentity(source.current.project) };
    }
    epoch.current = next?.epoch ?? null;
    setConnection((previous) => previous?.epoch === next?.epoch ? previous : next);
    setDevices(next?.devices ?? []);
  }

  async function refresh() {
    if (!invoke) return;
    setBusy(true);
    setNotice('');
    try {
      const status = await invoke<Status>('remote_status');
      setInterfaces(status.interfaces);
      setUpdatesEnabled(status.updatesEnabled);
      setAddress((previous) => status.interfaces.some((entry) => entry.address === previous)
        ? previous : status.interfaces[0]?.address ?? '');
      setRemoteConnection(status.connection);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!invoke) return;
    setBusy(true);
    setNotice('');
    try {
      if (connection) {
        setRemoteConnection(null);
        await invoke('remote_stop', { epoch: connection.epoch });
      } else {
        setRemoteConnection(await invoke<Connection>('remote_start', { address }));
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function kick(deviceId: number) {
    if (!invoke || !connection) return;
    setBusy(true);
    try {
      await invoke('remote_kick', { epoch: connection.epoch, deviceId });
      setDevices((previous) => previous.filter((device) => device.id !== deviceId));
      setNotice('Dispositivo expulsado.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Recover the current listener after a local WebView reload. No polling when off.
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!invoke || !connection) return;
    const call = invoke;
    const activeEpoch = connection.epoch;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let previousClock: Clock | undefined;
    let clockRevision = -1;
    let mixerConnected = connection.devices.some((device) => device.role === 'mixer');
    let meterFailed = false;
    let pending: Dispatch[] = [];
    let receipts: Receipt[] = [];
    let deadline = 0;

    const active = () => !disposed && epoch.current === activeEpoch;
    const stillTargets = (command: Dispatch, current: SongProject | null) =>
      activationCount.current === 0 && targets(command, current, revision.current.value);

    async function exchange() {
      if (!active()) return;
      try {
        const transport = audioEngine.getTransportState();
        const current = source.current.project;
        const currentRevision = revision.current.value;
        const awaiting: Dispatch[] = [];
        for (const command of pending) {
          if (!stillTargets(command, current)) {
            receipts.push({ id: command.id, outcome: 'stale' });
          } else if (current && matches(command, current)) {
            // App's existing updater has already updated the engine when React commits this state.
            receipts.push({ id: command.id, outcome: 'applied' });
          } else if (performance.now() >= deadline) {
            receipts.push({ id: command.id, outcome: 'unconfirmed' });
          } else {
            awaiting.push(command);
          }
        }
        pending = awaiting;
        const state = snapshot({ ...source.current, activating: activationCount.current > 0 }, transport, currentRevision,
          clockRevision === currentRevision ? previousClock : undefined, Date.now());
        previousClock = state.clock;
        clockRevision = currentRevision;
        let trackLevels: number[] = [];
        if (mixerConnected && state.clock.playing && !meterFailed) {
          try {
            const { tracks } = audioEngine.getTrackMeters();
            trackLevels = state.tracks.map(({ id }) => Math.round((tracks[id]?.rms ?? 0) * 100));
          } catch (error) {
            meterFailed = true;
            console.warn('[OmniTracks LAN] Medidores remotos suspendidos', error);
          }
        }

        const reply = await call<Exchange>('remote_exchange', {
          epoch: activeEpoch, snapshot: { ...state, levels: trackLevels }, receipts,
        });
        if (!active()) return;
        receipts = [];
        mixerConnected = reply.devices.some((device) => device.role === 'mixer');
        setDevices((previous) => sameDevices(previous, reply.devices) ? previous : reply.devices);
        if (reply.commands.length) {
          const byControl = new Map<string, Dispatch>();
          const mounting = audioEngine.getTransportState().isMountingSong;
          for (const command of reply.commands) {
            if (mounting || !stillTargets(command, source.current.project)) {
              receipts.push({ id: command.id, outcome: 'stale' });
              continue;
            }
            const key = command.trackId + ':' + command.command.type;
            const previous = byControl.get(key);
            if (previous) receipts.push({ id: previous.id, outcome: 'superseded' });
            byControl.set(key, command);
          }
          const batch = [...byControl.values()];
          if (batch.length) {
            pending = batch;
            deadline = performance.now() + COMMIT_TIMEOUT_MS;
            updateProject((previous) => {
              if (!active() || activationCount.current > 0 || audioEngine.getTransportState().isMountingSong
                || trackIdentity(previous) !== revision.current.identity) return previous;
              const applicable = batch.filter((command) => stillTargets(command, previous) && !matches(command, previous));
              return applicable.length ? applyMix(previous, applicable) : previous;
            });
          }
        }
        timer = setTimeout(exchange, EXCHANGE_MS);
      } catch (error) {
        if (!active()) return;
        console.error('[OmniTracks LAN] Falló el puente', error);
        setRemoteConnection(null);
        setNotice('Se interrumpió la conexión remota: ' + errorMessage(error));
        void call('remote_stop', { epoch: activeEpoch }).catch((stopError: unknown) => console.error('[OmniTracks LAN]', stopError));
      }
    }

    timer = setTimeout(exchange, 0);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [connection, activationCount, updateProject]);

  if (!invoke) return null;

  return (
    <>
      {triggerHost && createPortal(
        <button
          type="button"
          className="lt-control lt-remote-trigger"
          data-active={Boolean(connection)}
          aria-label={connection ? 'Conexión remota activa' : 'Conexión remota'}
          aria-haspopup="dialog"
          aria-controls="desktop-remote-dialog"
          title={connection ? 'Conexión remota · Activa' : 'Conexión remota'}
          onClick={() => {
            dialog.current?.showModal();
            if (!connection && !busy) void refresh();
          }}
        >
          <Radio size={16} aria-hidden="true" />
          <span>Conexión remota</span>
        </button>,
        triggerHost,
      )}
      <dialog ref={dialog} id="desktop-remote-dialog" className="lt-remote-dialog" aria-labelledby="desktop-remote-title"
        onKeyDown={(event) => event.stopPropagation()}>
        <header>
          <h2 id="desktop-remote-title">Conexión remota</h2>
          <button type="button" className="lt-control" onClick={() => dialog.current?.close()}>Cerrar</button>
        </header>
        <p>Conecta el portátil y los teléfonos a la misma red local de confianza.</p>
        <div className="lt-remote-options">
          {!connection && (
            <label className="lt-field">
              Interfaz de red
              <select value={address} onChange={(event) => setAddress(event.target.value)} disabled={busy}>
                {interfaces.length === 0 && <option value="">Sin interfaces IPv4 privadas</option>}
                {interfaces.map((entry) => (
                  <option key={entry.address} value={entry.address}>{entry.name} · {entry.address}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" role="switch" aria-checked={Boolean(connection)} className="lt-control"
            disabled={busy || (!address && !connection)} onClick={() => void toggle()}>
            {connection ? 'Apagar servidor LAN' : 'Encender servidor LAN'}
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {connection && (
          <>
            <p className="lt-remote-android-notice">
              <strong>Permiso en Android.</strong> Al abrir el QR, permite al navegador acceder a
              Dispositivos cercanos o a la red local si te lo solicita. Si ya lo rechazaste,
              revisa los permisos del navegador en Ajustes de Android y vuelve a abrir el QR.
            </p>
            <div className="lt-remote-pairings">
              {connection.pairings.map((pairing) => (
                <section key={pairing.role}>
                  <h3>{roleName[pairing.role]}</h3>
                  <img src={pairing.qr} width="192" height="192" alt={'QR de acceso para ' + roleName[pairing.role].toLowerCase()} />
                  <input aria-label={'URL de ' + roleName[pairing.role].toLowerCase()} readOnly value={pairing.url}
                    onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="lt-control" onClick={() => {
                    void navigator.clipboard.writeText(pairing.url).then(
                      () => setNotice('URL copiada.'),
                      () => setNotice('Selecciona y copia la URL del campo.'),
                    );
                  }}>Copiar URL</button>
                </section>
              ))}
            </div>
            <h3>Dispositivos conectados</h3>
            {devices.length === 0 ? <p>Aún no hay dispositivos conectados.</p> : (
              <ul>
                {devices.map((device) => (
                  <li key={device.id}>
                    <span>Dispositivo {device.id} · {roleName[device.role]} · {device.address}</span>
                    <button type="button" className="lt-control" disabled={busy} onClick={() => void kick(device.id)}>Expulsar</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {updatesEnabled && (
          <DesktopUpdates invoke={invoke} canUpdate={() => {
            const transport = audioEngine.getTransportState();
            return !busy && !epoch.current && activationCount.current === 0 && !transport.isPlaying && !transport.isMountingSong;
          }} />
        )}
      </dialog>
    </>
  );
});
