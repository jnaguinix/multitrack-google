/**
 * Qué dispositivo muestra y guarda «Audio» (plan 6.8). Si el dispositivo guardado no está conectado (una interfaz
 * USB desenchufada), NO se sustituye por el predeterminado: «Guardar» lo sobrescribiría y el click y la guía irían a los
 * altavoces de Windows en pleno servicio. Se muestra como «desconectado» y se conserva hasta que se elija otro.
 */
interface NamedDevice {
  name: string;
  isDefault: boolean;
}

export function chooseSelectedDevice(
  saved: string | null | undefined,
  devices: NamedDevice[]
): { name: string; missing: boolean } {
  if (saved) return { name: saved, missing: !devices.some((d) => d.name === saved) };
  const fallback = devices.find((d) => d.isDefault) || devices[0];
  return { name: fallback?.name ?? '', missing: false };
}

/** El dispositivo realmente presente que corresponde a la selección (`undefined` si la elegida no está conectada). */
export function resolveActiveDevice<T extends NamedDevice>(selected: string, devices: T[]): T | undefined {
  const found = devices.find((d) => d.name === selected);
  if (found) return found;
  if (selected) return undefined;
  return devices.find((d) => d.isDefault) || devices[0];
}
