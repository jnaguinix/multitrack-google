import { useState } from 'react';

type Props = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  canUpdate: () => boolean;
};

export default function DesktopUpdates({ invoke, canUpdate }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function advance() {
    if (busy) return;
    if (!canUpdate()) {
      setMessage('Detén la reproducción y apaga el servidor LAN para actualizar.');
      return;
    }
    setBusy(true);
    try {
      if (!version) {
        setMessage('Buscando actualizaciones…');
        const available = await invoke<string | null>('desktop_update_check');
        setVersion(available);
        setMessage(available ? `Disponible la versión ${available}.` : 'Ya tienes la versión más reciente.');
      } else if (!downloaded) {
        setMessage(`Descargando y verificando la versión ${version}…`);
        await invoke('desktop_update_download', { version });
        setDownloaded(true);
        setMessage(`Versión ${version} verificada. OmniTracks se cerrará al instalar.`);
      } else {
        setMessage('Abriendo el instalador…');
        await invoke('desktop_update_install', { version });
      }
    } catch (error) {
      console.warn('[OmniTracks] Error al actualizar', error);
      setMessage('No se pudo completar la actualización. Comprueba Internet y vuelve a intentarlo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Actualizaciones de escritorio">
      <button type="button" className="lt-control" disabled={busy} onClick={() => void advance()}>
        {downloaded ? 'Cerrar e instalar' : version ? 'Descargar actualización' : 'Buscar actualizaciones'}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
