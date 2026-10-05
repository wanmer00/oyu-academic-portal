import { parentPort, workerData } from 'worker_threads';
import { solve } from './solver';

/**
 * Worker thread: тяжёлый расчёт выполняется вне основного потока API.
 * Отмена — через SharedArrayBuffer (флаг проверяется солвером в цикле), прогресс — сообщениями.
 */
const flag = new Int32Array(workerData.flag as SharedArrayBuffer);
try {
  const result = solve(workerData.problem, {
    onProgress: (p) => parentPort!.postMessage({ type: 'progress', ...p }),
    shouldStop: () => Atomics.load(flag, 0) === 1,
  });
  parentPort!.postMessage({ type: 'done', result });
} catch (e: any) {
  parentPort!.postMessage({ type: 'error', message: String(e?.message ?? e) });
}
