
export * from './gan-smart-timer';
export * from './gan-smart-cube';
export * from './utils';

// The transport seam. Everything below it is platform; everything above it runs
// anywhere. See `gan-cube-transport.ts` for what that buys.
export type { GanCubeTransport, GanCubeDisconnectReason, RecordedMessage } from './gan-cube-transport';
export { SimulatedTransport } from './gan-cube-transport';
export { createGanCubeConnection, GanCubeTransportConnection } from './gan-cube-connection';
export { WebBluetoothTransport } from './transports/web-bluetooth';

// Protocol generations, as data — a platform adapter picks an encrypter and a
// driver from a generation number rather than knowing how they pair up.
export type { GanCubeGeneration, GanGenerationProfile } from './gan-cube-generations';
export {
    GAN_GENERATIONS,
    GAN_SERVICES,
    generationForService,
    saltFromMAC,
    createEncrypter,
    createDriver
} from './gan-cube-generations';

// Event and command types the protocol drivers produce and consume.
export type {
    GanCubeRawConnection,
    GanCubeEventMessage,
    GanCubeMoveEvent,
    GanCubeFaceletsEvent,
    GanCubeGyroEvent,
    GanCubeBatteryEvent,
    GanCubeHardwareEvent,
    GanCubeDisconnectEvent,
    GanCubeState,
    GanProtocolDriver
} from './gan-cube-protocol';
