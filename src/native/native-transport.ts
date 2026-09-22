
import { GanCubeTransport } from '../gan-cube-transport';
import { fromBase64, toBase64 } from './base64';
import { BlePlxCharacteristic, BlePlxDevice, BlePlxSubscription } from './ble-plx';

/**
 * A transport over `react-native-ble-plx`.
 *
 * Two things differ from the Web Bluetooth side and both are bridge artefacts:
 * values cross as base64 strings rather than `DataView`s, and subscriptions are
 * objects with `remove()` rather than event listeners. Neither reaches any code
 * above the transport.
 */
class NativeBleTransport implements GanCubeTransport {

    readonly deviceName: string;
    readonly deviceMAC: string;

    private device: BlePlxDevice;
    private serviceUUID: string;
    private commandUUID: string;
    private stateUUID: string;
    /** Gen4 exposes its command characteristic as write-without-response; the
     *  others take a response. Picked from the discovered characteristic rather
     *  than from the generation, so a firmware that disagrees still works. */
    private writeWithResponse: boolean;

    private messageHandler: ((data: Uint8Array) => void | Promise<void>) | null = null;
    private disconnectHandler: (() => void) | null = null;

    private monitorSubscription: BlePlxSubscription | null = null;
    private disconnectSubscription: BlePlxSubscription | null = null;
    private closed = false;

    private constructor(
        device: BlePlxDevice,
        mac: string,
        serviceUUID: string,
        command: BlePlxCharacteristic,
        stateUUID: string
    ) {
        this.device = device;
        this.deviceMAC = mac;
        this.deviceName = device.name || device.localName || 'GAN-XXXX';
        this.serviceUUID = serviceUUID;
        this.commandUUID = command.uuid;
        this.stateUUID = stateUUID;
        this.writeWithResponse = command.isWritableWithResponse || !command.isWritableWithoutResponse;
    }

    static async create(
        device: BlePlxDevice,
        mac: string,
        serviceUUID: string,
        command: BlePlxCharacteristic,
        stateUUID: string
    ): Promise<NativeBleTransport> {
        var transport = new NativeBleTransport(device, mac, serviceUUID, command, stateUUID);
        transport.monitorSubscription = device.monitorCharacteristicForService(
            serviceUUID,
            stateUUID,
            transport.onCharacteristicValue
        );
        transport.disconnectSubscription = device.onDisconnected(transport.onDeviceDisconnected);
        return transport;
    }

    async write(data: Uint8Array): Promise<void> {
        var value = toBase64(data);
        if (this.writeWithResponse) {
            await this.device.writeCharacteristicWithResponseForService(this.serviceUUID, this.commandUUID, value);
        } else {
            await this.device.writeCharacteristicWithoutResponseForService(this.serviceUUID, this.commandUUID, value);
        }
    }

    subscribe(handler: (data: Uint8Array) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    onDisconnect(handler: () => void): void {
        this.disconnectHandler = handler;
    }

    private onCharacteristicValue = (error: unknown, characteristic: BlePlxCharacteristic | null): void => {
        // Removing a subscription does not retract a notification already in
        // flight, so a frame can still arrive after teardown. Decoding it would
        // hand the driver a move the cube did not make on a connection that no
        // longer exists.
        if (this.closed) return;
        // A monitor reports the link dropping as an error on the subscription
        // rather than only through `onDisconnected`, so this is a real path to
        // teardown and not just logging.
        if (error) {
            this.onDeviceDisconnected();
            return;
        }
        var value = characteristic?.value;
        if (value) {
            this.messageHandler?.(fromBase64(value));
        }
    };

    private onDeviceDisconnected = (): void => {
        if (this.closed) return;
        this.closed = true;
        this.removeSubscriptions();
        this.disconnectHandler?.();
    };

    private removeSubscriptions(): void {
        this.monitorSubscription?.remove();
        this.monitorSubscription = null;
        this.disconnectSubscription?.remove();
        this.disconnectSubscription = null;
    }

    async disconnect(): Promise<void> {
        this.closed = true;
        this.removeSubscriptions();
        // The device may already be gone; cancelling a dead connection throws on
        // both platforms and means the same thing as success here.
        try {
            if (await this.device.isConnected()) {
                await this.device.cancelConnection();
            }
        } catch {
            // already disconnected
        }
    }

}

export {
    NativeBleTransport
};
