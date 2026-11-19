/**
 * Simulación del motor remoto SOLO para ver el diseño de «Conexión remota» en el servidor de
 * desarrollo (navegador, sin Tauri). No abre ningún servidor ni usa la red: devuelve datos de ejemplo.
 * Se descarta de la compilación de producción (`import.meta.env.DEV` es falso).
 */
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let running = false;

const connection = () => ({
  epoch: 'vista-previa',
  devices: [],
  pairings: [
    { role: 'monitor', url: 'http://192.168.0.10:8765/m/ejemplo-musicos' },
    { role: 'mixer', url: 'http://192.168.0.10:8765/s/ejemplo-sonidista' },
  ],
});

export const previewInvoke: Invoke = async <T,>(command: string): Promise<T> => {
  switch (command) {
    case 'remote_status':
      return {
        interfaces: [
          { name: 'Wi-Fi', address: '192.168.0.10' },
          { name: 'Ethernet', address: '10.0.0.24' },
        ],
        connection: running ? connection() : null,
        updatesEnabled: false,
      } as T;
    case 'remote_start':
      running = true;
      return connection() as T;
    case 'remote_stop':
      running = false;
      return undefined as T;
    case 'remote_exchange':
      return {
        commands: [],
        devices: [
          { id: 1, role: 'monitor', address: '192.168.0.23' },
          { id: 2, role: 'mixer', address: '192.168.0.31' },
        ],
      } as T;
    case 'remote_kick':
      return undefined as T;
    default:
      throw new Error(`Vista previa: el comando «${command}» no está simulado.`);
  }
};
