import React from 'react';
import { crashReportText } from '../../utils/crashReport';
import { debugMode } from '../../utils/debugMode';
import { diagnosticFileName, downloadTextFile, fullDiagnosticReport } from '../../utils/debugExport';

interface State {
  error: unknown;
  componentStack: string | null;
  /** Resultado de la última acción de diagnóstico (copiar, guardar), para que el usuario sepa si funcionó. */
  note: string | null;
}

/**
 * Red de seguridad de la raíz: si un componente lanza un error al dibujarse, React desmonta TODO el árbol y la
 * pantalla queda en blanco. Aquí se muestra en su lugar un mensaje con tres salidas (reintentar, recargar y copiar el
 * diagnóstico) y el error queda en la caja negra. Solo cubre fallos de dibujado: los de eventos y promesas ya los
 * recoge `invokeTraceInstall`. El audio sigue sonando: lo lleva el motor de Rust, no la interfaz.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, componentStack: null, note: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // `error` puede ser cualquier valor (se puede lanzar un texto): se guarda tal cual, aunque sea falsy.
    return { error: error ?? new Error('Error sin detalle'), note: null };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    debugMode.error('pantalla', error);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private report(): string {
    return crashReportText(
      this.state.error,
      this.state.componentStack,
      fullDiagnosticReport({ origen: 'fallo de pantalla' })
    );
  }

  private copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.report());
      this.setState({ note: 'Diagnóstico copiado. Pégalo en un mensaje.' });
    } catch (err) {
      console.warn('[ErrorBoundary] No se pudo copiar el diagnóstico:', err);
      this.setState({ note: 'No se pudo copiar. Usa «Guardar archivo».' });
    }
  };

  private save = (): void => {
    try {
      downloadTextFile(diagnosticFileName(), this.report());
      this.setState({ note: 'Archivo de diagnóstico guardado.' });
    } catch (err) {
      console.warn('[ErrorBoundary] No se pudo guardar el diagnóstico:', err);
      this.setState({ note: 'No se pudo guardar el archivo.' });
    }
  };

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div
        role="alert"
        className="lt-crash"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}
      >
        <div className="lt-dialog-panel" style={{ width: 'min(520px, 100%)', padding: 20 }}>
          <h1 style={{ fontSize: 18, fontWeight: 650 }}>Algo salió mal en la pantalla</h1>
          <p style={{ marginTop: 8, fontSize: 14 }}>
            La pantalla se detuvo por un error. Si había música sonando, sigue sonando: el audio no depende de la
            pantalla. Tus canciones y mezclas están guardadas.
          </p>
          <p style={{ marginTop: 8, fontSize: 12, opacity: 0.75, wordBreak: 'break-word' }}>
            {this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}
          </p>
          <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="lt-btn-primary"
              onClick={() => this.setState({ error: null, componentStack: null, note: null })}
            >
              Reintentar
            </button>
            <button type="button" className="lt-control" onClick={() => window.location.reload()}>
              Recargar la app
            </button>
            <button type="button" className="lt-control" onClick={() => void this.copy()}>
              Copiar diagnóstico
            </button>
            <button type="button" className="lt-control" onClick={this.save}>
              Guardar archivo
            </button>
          </div>
          {this.state.note && (
            <p role="status" style={{ marginTop: 10, fontSize: 12 }}>
              {this.state.note}
            </p>
          )}
        </div>
      </div>
    );
  }
}
