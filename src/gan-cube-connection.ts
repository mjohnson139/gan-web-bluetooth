
import { Subject } from 'rxjs';

import { now } from './utils';
import { GanCubeEncrypter } from './gan-cube-encrypter';
import { GanCubeDisconnectReason, GanCubeTransport } from './gan-cube-transport';
import {
    GanCubeCommand,
    GanCubeConnection,
    GanCubeEvent,
    GanCubeRawConnection,
    GanProtocolDriver
} from './gan-cube-protocol';

/**
 * The platform-free half of a cube connection.
 *
 * This used to be `GanCubeClassicConnection`, which did this job *and* owned a
 * pair of `BluetoothRemoteGATTCharacteristic`s. Splitting the two apart is the
 * whole of the change: what is left here is the pipeline — encrypt on the way
 * out, decrypt on the way in, hand the plaintext to the protocol driver, push
 * whatever events it returns onto `events$` — and it has no idea what is
 * carrying the bytes.
 *
 * The behaviour is deliberately identical to the class it replaces, including
 * the parts that look arbitrary:
 *
 *  - **Messages under 16 bytes are dropped.** AES works in 16-byte blocks and a
 *    short frame cannot be decrypted; some stacks deliver an empty notification
 *    when subscribing.
 *  - **`events$` is completed on disconnect.** A connection is not reusable;
 *    reconnecting means building a new one. Subscribers therefore get a
 *    termination rather than silence.
 */
class GanCubeTransportConnection implements GanCubeConnection, GanCubeRawConnection {

    private transport: GanCubeTransport;
    private encrypter: GanCubeEncrypter;
    private driver: GanProtocolDriver;

    events$: Subject<GanCubeEvent>;

    /** Guards against emitting DISCONNECT twice when both the link drops and
     *  `disconnect()` is called — which is the normal case, not an edge one. */
    private closed = false;

    private constructor(transport: GanCubeTransport, encrypter: GanCubeEncrypter, driver: GanProtocolDriver) {
        this.transport = transport;
        this.encrypter = encrypter;
        this.driver = driver;
        this.events$ = new Subject<GanCubeEvent>();
    }

    static async create(
        transport: GanCubeTransport,
        encrypter: GanCubeEncrypter,
        driver: GanProtocolDriver
    ): Promise<GanCubeConnection> {
        var conn = new GanCubeTransportConnection(transport, encrypter, driver);
        transport.subscribe(conn.onStateUpdate);
        transport.onDisconnect(conn.onDisconnect);
        return conn;
    }

    get deviceName(): string {
        return this.transport.deviceName || 'GAN-XXXX';
    }

    get deviceMAC(): string {
        return this.transport.deviceMAC || '00:00:00:00:00:00';
    }

    async sendCommandMessage(message: Uint8Array): Promise<void> {
        var encryptedMessage = this.encrypter.encrypt(message);
        return this.transport.write(encryptedMessage);
    }

    /**
     * Arrow property rather than a method: it is handed to the transport as a
     * bare callback, so it has to carry its own `this`.
     */
    onStateUpdate = async (eventMessage: Uint8Array): Promise<void> => {
        if (this.closed) return;
        if (eventMessage && eventMessage.byteLength >= 16) {
            var decryptedMessage = this.encrypter.decrypt(eventMessage);
            var cubeEvents = await this.driver.handleStateEvent(this, decryptedMessage);
            cubeEvents.forEach(e => this.events$.next(e));
        }
    };

    onDisconnect = (reason?: GanCubeDisconnectReason): void => {
        if (this.closed) return;
        this.closed = true;
        this.events$.next({ timestamp: now(), type: 'DISCONNECT', reason });
        this.events$.complete();
    };

    async sendCubeCommand(command: GanCubeCommand): Promise<void> {
        var commandMessage = this.driver.createCommandMessage(command);
        if (commandMessage) {
            return this.sendCommandMessage(commandMessage);
        }
    }

    async disconnect(): Promise<void> {
        this.onDisconnect();
        await this.transport.disconnect();
    }

}

/**
 * Build a cube connection over an already-connected transport.
 *
 * The encrypter and driver must match the cube's protocol generation;
 * `gan-cube-generations.ts` picks both from a generation number so that no
 * platform adapter has to know how they pair up.
 */
async function createGanCubeConnection(
    transport: GanCubeTransport,
    encrypter: GanCubeEncrypter,
    driver: GanProtocolDriver
): Promise<GanCubeConnection> {
    return GanCubeTransportConnection.create(transport, encrypter, driver);
}

export {
    GanCubeTransportConnection,
    createGanCubeConnection
};
