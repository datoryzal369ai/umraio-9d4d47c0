declare module "opus-media-recorder" {
  type WorkerOptions = {
    encoderWorkerFactory: () => Worker;
    OggOpusEncoderWasmPath: string;
  };

  export default class OpusMediaRecorder extends MediaRecorder {
    constructor(stream: MediaStream, options: MediaRecorderOptions, workerOptions: WorkerOptions);
  }
}