
/**
 * The shape of `react-native-ble-plx` that this library actually uses.
 *
 * These are structural types rather than an import. The library therefore has no
 * dependency on `react-native-ble-plx` — not a runtime one, not a peer one, not
 * even a type-only one — and an app is free to be on any version of it, or to
 * pass something else entirely that behaves the same way. It also means this
 * file, and everything that consumes it, can be tested in node against a fake.
 */

/** A characteristic as `discoverAllServicesAndCharacteristics` reports it. */
interface BlePlxCharacteristic {
    readonly uuid: string;
    readonly isWritableWithResponse: boolean;
    readonly isWritableWithoutResponse: boolean;
    /** Base64, or null when the notification carried no value. */
    readonly value?: string | null;
}

interface BlePlxService {
    readonly uuid: string;
    characteristics(): Promise<Array<BlePlxCharacteristic>>;
}

/** Whatever `subscription.remove()` can be called on. */
interface BlePlxSubscription {
    remove(): void;
}

interface BlePlxDevice {
    readonly id: string;
    readonly name?: string | null;
    readonly localName?: string | null;
    /** Base64 of the advertisement's manufacturer-specific data, including the
     *  two-byte company identifier. Populated on scan results; frequently null
     *  on a device fetched any other way, which is the whole iOS problem. */
    readonly manufacturerData?: string | null;
    readonly serviceUUIDs?: Array<string> | null;

    connect(options?: { requestMTU?: number; timeout?: number }): Promise<BlePlxDevice>;
    discoverAllServicesAndCharacteristics(): Promise<BlePlxDevice>;
    services(): Promise<Array<BlePlxService>>;
    isConnected(): Promise<boolean>;
    cancelConnection(): Promise<BlePlxDevice>;
    onDisconnected(listener: (error: unknown, device: BlePlxDevice | null) => void): BlePlxSubscription;

    writeCharacteristicWithResponseForService(serviceUUID: string, characteristicUUID: string, valueBase64: string): Promise<BlePlxCharacteristic>;
    writeCharacteristicWithoutResponseForService(serviceUUID: string, characteristicUUID: string, valueBase64: string): Promise<BlePlxCharacteristic>;
    monitorCharacteristicForService(
        serviceUUID: string,
        characteristicUUID: string,
        listener: (error: unknown, characteristic: BlePlxCharacteristic | null) => void
    ): BlePlxSubscription;
}

interface BlePlxManager {
    startDeviceScan(
        serviceUUIDs: Array<string> | null,
        options: { allowDuplicates?: boolean } | null,
        listener: (error: unknown, device: BlePlxDevice | null) => void
    ): void;
    stopDeviceScan(): void;
    state(): Promise<string>;
}

export type {
    BlePlxCharacteristic,
    BlePlxService,
    BlePlxSubscription,
    BlePlxDevice,
    BlePlxManager
};
