declare module 'network' {
  interface NetworkInterfaceState {
    readonly connected: boolean;
    readonly ip: string;
    readonly mac: string;
  }

  interface NetworkState {
    readonly dhcp?: {
      readonly ethernet?: NetworkInterfaceState;
      readonly wifi?: NetworkInterfaceState;
    };
  }

  export function getState(): NetworkState;
}
