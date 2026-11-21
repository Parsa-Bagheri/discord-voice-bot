// Minimal typings for the parts of sherpa-onnx-node we use (the package ships JSDoc only).
declare module 'sherpa-onnx-node' {
  export interface OnlineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  }

  export interface KeywordSpotterConfig {
    featConfig?: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads?: number;
      provider?: 'cpu' | 'cuda' | 'coreml';
      debug?: number;
    };
    maxActivePaths?: number;
    numTrailingBlanks?: number;
    keywordsScore?: number;
    keywordsThreshold?: number;
    keywordsFile?: string;
  }

  export interface KeywordResult {
    start_time: number;
    keyword: string;
    timestamps: number[];
    tokens: string[];
  }

  export class KeywordSpotter {
    constructor(config: KeywordSpotterConfig);
    readonly config: KeywordSpotterConfig;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): KeywordResult;
  }

  const sherpa: { KeywordSpotter: typeof KeywordSpotter };
  export default sherpa;
}
