
import { GanCubeDisconnectReason, GanCubeTransport } from '../gan-cube-transport';
import { fromBase64, toBase64 } from './base64';
import { BlePlxCharacteristic, BlePlxDevice, BlePlxSubscription } from './ble-plx';

/** Pulls whatever a platform error is willing to say about itself, without
 *  assuming it is a `BleError` — this transport has no dependency on
 *  `react-native-ble-plx`'s types, only on what its errors happen to carry. */
function errorReasonFields(error: unknown): { code?: string | number; message?: string } {
    if (error && typeof error === 'object') {
        var e = error as { errorCode?: string | number; message?: string };
        return { code: e.errorCode, message: e.message };
    }
    return {};
}

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
    private disconnectHandler: ((reason?: GanCubeDisconnectReason) => void) | null = null;

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

    onDisconnect(handler: (reason?: GanCubeDisconnectReason) => void): void {
        this.disconnectHandler = handler;
    }

    private onCharacteristicValue = async (error: unknown, characteristic: BlePlxCharacteristic | null): Promise<void> => {
        // Removing a subscription does not retract a notification already in
        // flight, so a frame can still arrive after teardown. Decoding it would
        // hand the driver a move the cube did not make on a connection that no
        // longer exists.
        if (this.closed) return;
        if (error) {
            // A monitor error does not by itself mean the link is down — ble-plx
            // can surface a transient error on this subscription while
            // `device.isConnected()` still says yes, and the OS-level link
            // outlives it. Tearing down on every such error was closing sessions
            // the phone hadn't actually dropped. Only a monitor error on a link
            // that is genuinely gone is treated as a disconnect; otherwise the
            // (now-dead) subscription is replaced and the link stays up.
            var stillConnected = await this.device.isConnected().catch(() => false);
            if (stillConnected) {
                this.resubscribeMonitor();
                return;
            }
            this.finish({ source: 'monitor', ...errorReasonFields(error) });
            return;
        }
        var value = characteristic?.value;
        if (value) {
            this.messageHandler?.(fromBase64(value));
        }
    };

    private resubscribeMonitor(): void {
        this.monitorSubscription?.remove();
        this.monitorSubscription = this.device.monitorCharacteristicForService(
            this.serviceUUID,
            this.stateUUID,
            this.onCharacteristicValue
        );
    }

    private onDeviceDisconnected = (error: unknown): void => {
        this.finish({ source: 'onDisconnected', ...errorReasonFields(error) });
    };

    private finish(reason?: GanCubeDisconnectReason): void {
        if (this.closed) return;
        this.closed = true;
        this.removeSubscriptions();
        this.disconnectHandler?.(reason);
    }

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
