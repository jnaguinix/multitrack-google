import { useCallback, useState } from 'react';

/** Aviso breve de la app («toast»): un mensaje a la vez, se oculta solo a los 3,4 s. */
export function useToast() {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  return { toastMessage, showToast };
}
