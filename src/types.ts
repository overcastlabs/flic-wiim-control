export interface AppConfig {
  readonly debug: boolean;
  readonly healthLogIntervalMs: number;
  readonly subscription: {
    readonly timeoutSeconds: number;
    readonly renewalMarginSeconds: number;
    readonly renewalStaggerSeconds: number;
    readonly retryDelayMs: number;
    readonly maxRetries: number;
  };
  readonly ssdp: {
    readonly address: string;
    readonly port: number;
    readonly maximumWaitSeconds: number;
    readonly retryDelayMs: number;
    readonly searchTargets: readonly string[];
  };
  readonly renderingControlService: string;
  readonly avTransportService: string;
  readonly slaveListPath: string;
  readonly preset: {
    readonly minimum: number;
    readonly maximum: number;
  };
}

export interface HttpRequestOptions {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string | number>>;
  readonly content?: string;
  readonly rejectUnauthorized?: boolean;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  content: string;
}

export interface WiimDevice {
  readonly name: string;
  readonly model: string;
  readonly location: string;
  readonly baseUrl: string;
  readonly renderingControlUrl: string;
  readonly renderingEventUrl: string;
  readonly avTransportControlUrl: string;
  readonly usn: string | null;
}

export type DeviceMap = Map<string, WiimDevice>;

export type TransportCommand =
  | 'play'
  | 'pause'
  | 'stop'
  | 'next'
  | 'previous';

export type ActionMessage =
  | {
      readonly deviceId: string;
      readonly command: TransportCommand;
    }
  | {
      readonly deviceId: string;
      readonly command: 'preset';
      readonly preset: number;
    };
