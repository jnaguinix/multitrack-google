// Un error al dibujar un componente no deja la pantalla en blanco: la raíz muestra un aviso con diagnóstico (plan 5.1).
import fs from 'node:fs';
import React from 'react';
import { ErrorBoundary } from '../src/components/app/ErrorBoundary';
import { crashReportText } from '../src/utils/crashReport';
import { debugMode } from '../src/utils/debugMode';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// El informe lleva el error, su pila, los componentes y el diagnóstico.
const boom = new Error('fallo de prueba');
const text = crashReportText(boom, '\n    at Mezcla\n    at App', 'DIAGNOSTICO-AQUI');
assert(text.includes('fallo de prueba'), 'el informe lleva el mensaje');
assert(text.includes('at Mezcla') && text.includes('at App'), 'el informe lleva la pila de componentes');
assert(text.includes('DIAGNOSTICO-AQUI'), 'el informe lleva el diagnóstico completo');
assert(crashReportText('texto suelto', null, 'd').includes('(no disponible)'), 'sin pila de componentes lo dice');
assert(crashReportText('texto suelto', null, 'd').includes('texto suelto'), 'se puede lanzar algo que no es un Error');

// El ErrorBoundary: sin error deja pasar a los hijos; con error pasa al aviso.
const child = React.createElement('span', null, 'hijo');
const inst = new ErrorBoundary({ children: child });
inst.setState = ((s: object) => Object.assign(inst.state, s)) as typeof inst.setState;
assert(inst.render() === child, 'sin error muestra la aplicación');

const derived = ErrorBoundary.getDerivedStateFromError(boom);
assert(derived.error === boom, 'getDerivedStateFromError guarda el error (sin esto React deja la pantalla en blanco)');
Object.assign(inst.state, derived);
const fallback = inst.render() as React.ReactElement<{ role?: string }>;
assert(fallback !== child && fallback.props.role === 'alert', 'con error muestra el aviso, no la aplicación');

// Un valor falsy lanzado (throw 0, throw '') también cuenta como error.
assert(ErrorBoundary.getDerivedStateFromError('').error !== null, 'un error vacío no se confunde con «sin error»');

// El error queda en el registro aunque el modo diagnóstico esté apagado.
assert(debugMode.enabled === false, 'el modo diagnóstico está apagado en la prueba');
const before = debugMode.all().length;
inst.componentDidCatch(boom, { componentStack: '\n    at Mezcla' } as React.ErrorInfo);
const logged = debugMode.all().slice(before).some((e) => e.category === 'error' && e.detail.includes('pantalla') && e.detail.includes('fallo de prueba'));
assert(logged, 'el error de pantalla queda en el registro con el modo apagado');
assert(inst.state.componentStack?.includes('at Mezcla') === true, 'guarda la pila de componentes');

// La raíz envuelve la aplicación: sin esto el componente existe pero no protege nada.
const main = fs.readFileSync('src/main.tsx', 'utf8');
assert(/<ErrorBoundary>\s*<App\s*\/>\s*<\/ErrorBoundary>/.test(main), 'main.tsx envuelve <App /> en <ErrorBoundary>');

console.log('errorBoundary: OK');
