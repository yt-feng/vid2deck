import { pipeline } from '@xenova/transformers';

type WorkerMessage =
  | { type: 'load' }
  | { type: 'transcribe'; id: number; audio: Float32Array };

type PipelineFn = (input: unknown, options?: Record<string, unknown>) => Promise<unknown>;

type WorkerLike = {
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
};

const workerSelf = self as unknown as WorkerLike;
let transcriber: PipelineFn | null = null;

function textFromResult(result: unknown): string {
  if (Array.isArray(result)) {
    return result.map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text ?? '') : '')).join('\n').trim();
  }
  if (result && typeof result === 'object' && 'text' in result) {
    return String((result as { text?: unknown }).text ?? '').trim();
  }
  return '';
}

workerSelf.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
        progress_callback: (progress: { status?: string; progress?: number }) => {
          workerSelf.postMessage({ type: 'model-progress', status: progress.status ?? '', progress: progress.progress });
        }
      }) as PipelineFn;
      workerSelf.postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'transcribe') {
      if (!transcriber) throw new Error('ASR model is not loaded');
      const result = await transcriber(message.audio, {
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 3
      });
      workerSelf.postMessage({ type: 'result', id: message.id, text: textFromResult(result) });
    }
  } catch (error) {
    workerSelf.postMessage({
      type: 'error',
      id: message.type === 'transcribe' ? message.id : undefined,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
