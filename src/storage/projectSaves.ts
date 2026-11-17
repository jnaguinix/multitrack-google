import { logAsyncError } from '../utils/asyncErrors';
import type { SongProject } from '../types/project';
import { saveProjectToDb } from './projectDb';
import { SaveScheduler } from './saveScheduler';

/**
 * Guardado de canciones de la mezcla: los cambios continuos (arrastrar un fader) se agrupan en un solo guardado
 * a los 400 ms; cualquier otro cambio guarda al momento. Se vacía al ocultar o cerrar la ventana.
 */
export const projectSaves = new SaveScheduler<SongProject>(saveProjectToDb, logAsyncError('guardar la canción'), 400);
