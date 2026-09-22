
/**
 * The seam between this library and whatever is actually carrying bytes to the
 * cube.
 *
 * Everything above this interface — the three protocol drivers, the encrypters,
 * the bit-level message view — is pure computation over `Uint8Array` and runs
 * anywhere JavaScript runs. Everything below it is platform: Web Bluetooth in a
 * browser, `react-native-ble-plx` on a phone, a recorded stream in a test.
 *
 * A transport is handed to it already connected. Discovery, pairing, MAC address
 * retrieval and characteristic lookup all belong to the platform adapter,
 * because every platform does them differently and none of them can be expressed
 * in terms of the others.
 */
interface GanCubeTransport {

    /** Advertised device name, e.g. `GANicC1a2b3`. */
    readonly deviceName: string;

    /**
     * Device MAC address, in colon-separated uppercase hex.
     *
     * This is not informational: the GAN encryption key and IV are salted with
     * these six bytes, so a transport that cannot produce a real MAC cannot be
     * used to talk to a real cube. See the adapters for how each platform gets
     * hold of one — it is the single hardest part of supporting a new platform.
     */
    readonly deviceMAC: string;

    /** Write one already-encrypted message to the cube's command characteristic. */
    write(data: Uint8Array): Promise<void>;

    /**
     * Register the handler for encrypted messages arriving on the cube's state
     * characteristic. Called once, by the connection, during construction.
     *
     * The handler is async — decrypting a frame and parsing it can hand back
     * several events, and a Gen3 driver may issue a follow-up request while
     * doing it. A hardware transport has nowhere to await that and ignores the
     * promise; `SimulatedTransport` awaits it, which is what lets a test assert
     * on the events a frame produced rather than on an empty array.
     */
    subscribe(handler: (data: Uint8Array) => void | Promise<void>): void;

    /**
     * Register the handler for the link dropping without us asking — the cube
     * being switched off, walking out of range, or the OS reclaiming the
     * connection. Called once, by the connection, during construction.
     */
    onDisconnect(handler: () => void): void;

    /** Tear the link down. Must be safe to call more than once. */
    disconnect(): Promise<void>;
}

/**
 * One recorded message, as a transport would have delivered it.
 *
 * `delayMs` is the gap *after* the previous message, so a recording reads in the
 * order it happened rather than as absolute offsets from a start that has to be
 * remembered.
 */
type RecordedMessage = {
    /** Milliseconds to wait after the previous message before delivering this one. */
    delayMs?: number;
    /** The message bytes, exactly as the cube would have sent them — encrypted. */
    data: Uint8Array;
};

/**
 * A transport with no cube behind it.
 *
 * This exists for three reasons, and the third is the one that shapes the app:
 *
 *  1. The protocol drivers can be tested in node, against captured bytes, with
 *     no hardware and no browser.
 *  2. A recorded session can be replayed to reproduce a bug exactly.
 *  3. **The app stays runnable where BLE is not.** `react-native-ble-plx` is a
 *     native module, so it is absent from Expo Go and from the web build. An app
 *     that can fall back to this transport still starts, still renders, and
 *     still exercises every line of logic above the seam — which is nearly all
 *     of the logic there is.
 *
 * Messages are delivered already encrypted, because that is what a transport
 * carries; the connection decrypts them exactly as it would a real cube's. A
 * recording captured from real hardware therefore replays through the genuine
 * decrypt-and-parse path rather than around it.
 */
class SimulatedTransport implements GanCubeTransport {

    readonly deviceName: string;
    readonly deviceMAC: string;

    /** Every message written by the connection, in order, for tests to assert on. */
    readonly written: Array<Uint8Array> = [];

    private messageHandler: ((data: Uint8Array) => void | Promise<void>) | null = null;
    private disconnectHandler: (() => void) | null = null;
    private timers: Array<ReturnType<typeof setTimeout>> = [];
    private closed = false;

    constructor(options: { deviceName?: string; deviceMAC?: string } = {}) {
        this.deviceName = options.deviceName ?? 'GAN-SIMULATED';
        this.deviceMAC = options.deviceMAC ?? 'AB:12:34:56:78:9A';
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.closed)
            throw new Error('Transport is disconnected');
        this.written.push(new Uint8Array(data));
    }

    subscribe(handler: (data: Uint8Array) => void | Promise<void>): void {
        this.messageHandler = handler;
    }

    onDisconnect(handler: () => void): void {
        this.disconnectHandler = handler;
    }

    /**
     * Deliver one message immediately, as if the cube had just sent it.
     *
     * Returns the connection's processing promise so a caller can await the
     * events it produced. Awaiting is optional — real hardware never does — but
     * without it a test sees the array before the driver has filled it.
     */
    emit(data: Uint8Array): void | Promise<void> {
        if (!this.closed)
            return this.messageHandler?.(data);
    }

    /**
     * Replay a recording, honouring the gaps between messages.
     *
     * Resolves once the last message has been delivered. A `delayMs` of 0 — the
     * default — still yields to the event loop between messages, so a replay
     * never delivers a whole session inside one synchronous turn and hides an
     * ordering bug that real timing would expose.
     */
    async replay(messages: Array<RecordedMessage>): Promise<void> {
        for (let message of messages) {
            await new Promise<void>((resolve) => {
                let timer = setTimeout(async () => {
                    this.timers = this.timers.filter((t) => t != timer);
                    await this.emit(message.data);
                    resolve();
                }, message.delayMs ?? 0);
                this.timers.push(timer);
            });
            if (this.closed) break;
        }
    }

    /** Drop the link the way a cube being switched off would. */
    simulateDisconnect(): void {
        if (this.closed) return;
        this.closed = true;
        this.clearTimers();
        this.disconnectHandler?.();
    }

    async disconnect(): Promise<void> {
        this.closed = true;
        this.clearTimers();
    }

    private clearTimers(): void {
        this.timers.forEach(clearTimeout);
        this.timers = [];
    }

}

export type {
    GanCubeTransport,
    RecordedMessage
};

export {
    SimulatedTransport
};
