
import { GanCubeTransport } from '../gan-cube-transport';

/**
 * A transport over the browser's Web Bluetooth API.
 *
 * This is the plumbing that `GanCubeClassicConnection` used to own inline. It is
 * unchanged in behaviour — the same two characteristics, the same
 * `startNotifications`, the same `gattserverdisconnected` listener — and exists
 * separately only so that everything above it stops depending on `navigator`.
 */
class WebBluetoothTransport implements GanCubeTransport {

    private device: BluetoothDevice;
    private commandCharacteristic: BluetoothRemoteGATTCharacteristic;
    private stateCharacteristic: BluetoothRemoteGATTCharacteristic;
    private mac: string;

    private messageHandler: ((data: Uint8Array) => void | Promise<void>) | null = null;
    private disconnectHandler: (() => void) | null = null;
    private closed = false;

    constructor(
        device: BluetoothDevice,
        mac: string,
        commandCharacteristic: BluetoothRemoteGATTCharacteristic,
        stateCharacteristic: BluetoothRemoteGATTCharacteristic
    ) {
        this.device = device;
        this.mac = mac;
        this.commandCharacteristic = commandCharacteristic;
        this.stateCharacteristic = stateCharacteristic;
    }

    /** Attach listeners and start notifications. Separate from the constructor
     *  because both are async and a half-built transport must not escape. */
    static async create(
        device: BluetoothDevice,
        mac: string,
        commandCharacteristic: BluetoothRemoteGATTCharacteristic,
        stateCharacteristic: BluetoothRemoteGATTCharacteristic
    ): Promise<WebBluetoothTransport> {
        var transport = new WebBluetoothTransport(device, mac, commandCharacteristic, stateCharacteristic);
        device.addEventListener('gattserverdisconnected', transport.onGattDisconnected);
        stateCharacteristic.addEventListener('characteristicvaluechanged', transport.onCharacteristicValueChanged);
        await stateCharacteristic.startNotifications();
        return transport;
    }

    get deviceName(): string {
        return this.device.name || 'GAN-XXXX';
    }

    get deviceMAC(): string {
        return this.mac;
    }

    async write(data: Uint8Array): Promise<void> {
        return this.commandCharacteristic.writeValue(data);
    }

    subscribe(handler: (data: Uint8Array) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    onDisconnect(handler: () => void): void {
        this.disconnectHandler = handler;
    }

    private onCharacteristicValueChanged = (evt: Event): void => {
        // See the native transport: a removed listener can still see a
        // notification that was already dispatched.
        if (this.closed) return;
        var characteristic = evt.target as BluetoothRemoteGATTCharacteristic;
        var value = characteristic.value;
        if (value) {
            // A DataView may be a window onto a larger buffer; copy through its
            // own offset and length rather than trusting `.buffer` to start here.
            this.messageHandler?.(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        }
    };

    private onGattDisconnected = (): void => {
        if (this.closed) return;
        this.closed = true;
        this.detach();
        this.disconnectHandler?.();
    };

    private detach(): void {
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
        this.stateCharacteristic.removeEventListener('characteristicvaluechanged', this.onCharacteristicValueChanged);
    }

    async disconnect(): Promise<void> {
        this.closed = true;
        this.detach();
        await this.stateCharacteristic.stopNotifications().catch(() => { });
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }

}

export {
    WebBluetoothTransport
};
