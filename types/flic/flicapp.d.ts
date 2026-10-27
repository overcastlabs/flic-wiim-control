declare module 'flicapp' {
  export interface VirtualDeviceMetadata {
    readonly buttonId: string;
    readonly dimmableType: 'Light' | 'Blind' | 'Speaker';
    readonly virtualDeviceId: string;
  }

  export interface VirtualDeviceValues {
    readonly colorTemperature?: number;
    readonly brightness?: number;
    readonly hue?: number;
    readonly saturation?: number;
    readonly volume?: number;
    readonly position?: number;
  }

  interface FlicApp {
    on(
      event: 'virtualDeviceUpdate',
      listener: (
        metadata: VirtualDeviceMetadata,
        values: VirtualDeviceValues,
      ) => void,
    ): this;
    on(event: 'actionMessage', listener: (message: string) => void): this;
    virtualDeviceUpdateState(
      type: 'Light' | 'Blind' | 'Speaker',
      id: string,
      values: VirtualDeviceValues,
    ): void;
  }

  const flicapp: FlicApp;
  export = flicapp;
}
