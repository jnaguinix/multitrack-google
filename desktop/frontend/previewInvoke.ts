/**
 * Simulación del motor remoto SOLO para ver el diseño de «Conexión remota» en el servidor de
 * desarrollo (navegador, sin Tauri). No abre ningún servidor ni usa la red: devuelve datos de ejemplo.
 * Se descarta de la compilación de producción (`import.meta.env.DEV` es falso).
 */
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const qr = (seed: number) => {
  const cells: string[] = [];
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      if (finder || ((x * 7 + y * 13 + seed) % 5 < 2)) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 23 23"><rect x="-1" y="-1" width="23" height="23" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};

let running = false;

const connection = () => ({
  epoch: 'vista-previa',
  devices: [],
  pairings: [
    { role: 'monitor', url: 'http://192.168.0.10:8765/m/ejemplo-musicos', qr: qr(1) },
    { role: 'mixer', url: 'http://192.168.0.10:8765/s/ejemplo-sonidista', qr: qr(3) },
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
