
import { describe, expect, it, vi } from 'vitest';

import { fromBase64, toBase64 } from '../src/native/base64';
import { formatMAC, macFromManufacturerData, resolveCubeMAC } from '../src/native/mac-address';
import { NativeBleTransport } from '../src/native/native-transport';
import { isGanCubeName, scanForGanCubes } from '../src/native/index';
import { BlePlxCharacteristic, BlePlxDevice, BlePlxManager, BlePlxService } from '../src/native/ble-plx';

describe('base64 at the bridge boundary', () => {

    it('round-trips every length up to three blocks', () => {
        for (let length = 0; length <= 48; length++) {
            let bytes = new Uint8Array(length);
            for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) & 0xFF;
            expect(Array.from(fromBase64(toBase64(bytes))), `length ${length}`).toEqual(Array.from(bytes));
        }
    });

    it('agrees with known vectors', () => {
        expect(toBase64(new Uint8Array([0x4D, 0x61, 0x6E]))).toBe('TWFu');
        expect(toBase64(new Uint8Array([0x4D, 0x61]))).toBe('TWE=');
        expect(toBase64(new Uint8Array([0x4D]))).toBe('TQ==');
        expect(Array.from(fromBase64('TWFu'))).toEqual([0x4D, 0x61, 0x6E]);
    });

    it('preserves high bytes, which is all a cube frame is', () => {
        var frame = new Uint8Array(20).fill(0xFF);
        frame[7] = 0x00;
        expect(Array.from(fromBase64(toBase64(frame)))).toEqual(Array.from(frame));
    });

    it('tolerates missing padding and embedded whitespace', () => {
        expect(Array.from(fromBase64('TWFu\n'))).toEqual([0x4D, 0x61, 0x6E]);
        expect(Array.from(fromBase64('TWE'))).toEqual([0x4D, 0x61]);
    });

});

describe('finding a cube MAC address', () => {

    /** Manufacturer data as GAN advertises it: two CIC bytes, then a nine-byte
     *  payload whose last six are the MAC backwards. */
    function advertisement(mac: Array<number>): string {
        var raw = new Uint8Array([0x01, 0x00, 0xAA, 0xBB, 0xCC, ...mac.slice().reverse()]);
        return toBase64(raw);
    }

    it('formats six bytes as colon-separated uppercase hex', () => {
        expect(formatMAC(new Uint8Array([0xAB, 0x01, 0x34, 0x56, 0x78, 0x9A])))
            .toBe('AB:01:34:56:78:9A');
    });

    it('reads the MAC out of an advertisement', () => {
        expect(macFromManufacturerData(advertisement([0xAB, 0x12, 0x34, 0x56, 0x78, 0x9A])))
            .toBe('AB:12:34:56:78:9A');
    });

    it('returns null for a device that advertises nothing useful', () => {
        expect(macFromManufacturerData(null)).toBeNull();
        expect(macFromManufacturerData(undefined)).toBeNull();
        expect(macFromManufacturerData(toBase64(new Uint8Array([0x01, 0x00, 0x02])))).toBeNull();
    });

    function device(overrides: Partial<BlePlxDevice>): BlePlxDevice {
        return { id: 'x', name: 'GANicTEST', ...overrides } as BlePlxDevice;
    }

    it('uses the device id on Android, where it is the MAC', async () => {
        var result = await resolveCubeMAC(device({ id: 'ab:12:34:56:78:9a' }));
        expect(result).toBe('AB:12:34:56:78:9A');
    });

    it('falls back to the advertisement on iOS, where the id is a random UUID', async () => {
        var result = await resolveCubeMAC(device({
            id: '6C4B8F2E-1A3D-4E5F-9B7C-0D1E2F3A4B5C',
            manufacturerData: advertisement([0xAB, 0x12, 0x34, 0x56, 0x78, 0x9A])
        }));
        expect(result).toBe('AB:12:34:56:78:9A');
    });

    it('asks the app only when neither route worked', async () => {
        var provider = vi.fn().mockResolvedValue('AB:12:34:56:78:9A');
        var result = await resolveCubeMAC(device({ id: 'not-a-mac' }), provider);
        expect(result).toBe('AB:12:34:56:78:9A');
        expect(provider).toHaveBeenCalledOnce();
    });

    it('does not ask the app when the advertisement already answered', async () => {
        var provider = vi.fn();
        await resolveCubeMAC(device({
            id: 'not-a-mac',
            manufacturerData: advertisement([0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
        }), provider);
        expect(provider).not.toHaveBeenCalled();
    });

    it('explains the iOS constraint when it gives up', async () => {
        // The message has to name the cause, because the symptom — a cube that
        // is visible and will not connect — points nowhere near a scan record.
        await expect(resolveCubeMAC(device({ id: 'not-a-mac' })))
            .rejects.toThrow(/scan result/);
    });

    it('rejects a provider answer that is not a MAC', async () => {
        var provider = vi.fn().mockResolvedValue('nonsense typed into a text field');
        await expect(resolveCubeMAC(device({ id: 'not-a-mac' }), provider)).rejects.toThrow();
    });

});

describe('scanning', () => {

    it('recognises the names GAN cubes advertise under', () => {
        expect(isGanCubeName('GANicC1a2b3')).toBe(true);
        expect(isGanCubeName('MG3Ai_1234')).toBe(true);
        expect(isGanCubeName('AiCube1234')).toBe(true);
        expect(isGanCubeName('Galaxy Buds')).toBe(false);
        expect(isGanCubeName('')).toBe(false);
        expect(isGanCubeName(null)).toBe(false);
    });

    function fakeManager() {
        var listener: ((error: unknown, device: BlePlxDevice | null) => void) | null = null;
        var stopped = 0;
        var manager: BlePlxManager = {
            startDeviceScan: (_uuids, _options, cb) => { listener = cb; },
            stopDeviceScan: () => { stopped++; },
            state: async () => 'PoweredOn'
        };
        return { manager, emit: (d: Partial<BlePlxDevice>) => listener?.(null, d as BlePlxDevice), fail: (e: unknown) => listener?.(e, null), stopped: () => stopped };
    }

    it('reports GAN cubes and ignores everything else', () => {
        var { manager, emit } = fakeManager();
        var results: Array<string> = [];
        scanForGanCubes(manager, (r) => results.push(r.name));
        emit({ id: 'a', name: 'GANicC1a2b3' });
        emit({ id: 'b', name: 'Some Headphones' });
        emit({ id: 'c', localName: 'MG3Ai_99' });
        expect(results).toEqual(['GANicC1a2b3', 'MG3Ai_99']);
    });

    it('reports each cube once, however many advertisements arrive', () => {
        var { manager, emit } = fakeManager();
        var results: Array<string> = [];
        scanForGanCubes(manager, (r) => results.push(r.id));
        emit({ id: 'a', name: 'GANicC1a2b3' });
        emit({ id: 'a', name: 'GANicC1a2b3' });
        expect(results).toEqual(['a']);
    });

    it('resolves the MAC while the advertisement is still in hand', () => {
        var { manager, emit } = fakeManager();
        var macs: Array<string | null> = [];
        scanForGanCubes(manager, (r) => macs.push(r.mac));
        emit({ id: 'AB:12:34:56:78:9A', name: 'GANicC1a2b3' });
        emit({
            id: '6C4B8F2E-1A3D-4E5F-9B7C-0D1E2F3A4B5C',
            name: 'GANicOTHER',
            manufacturerData: toBase64(new Uint8Array([0x01, 0x00, 0xAA, 0xBB, 0xCC, 0x9A, 0x78, 0x56, 0x34, 0x12, 0xAB]))
        });
        expect(macs).toEqual(['AB:12:34:56:78:9A', 'AB:12:34:56:78:9A']);
    });

    it('marks a cube whose MAC could not be resolved rather than hiding it', () => {
        // A row that says "cannot connect" is honest; one that is absent looks
        // like the cube is off.
        var { manager, emit } = fakeManager();
        var macs: Array<string | null> = [];
        scanForGanCubes(manager, (r) => macs.push(r.mac));
        emit({ id: '6C4B8F2E-1A3D-4E5F-9B7C-0D1E2F3A4B5C', name: 'GANicC1a2b3' });
        expect(macs).toEqual([null]);
    });

    it('surfaces scan errors and stops exactly once', () => {
        var { manager, fail, stopped } = fakeManager();
        var errors: Array<unknown> = [];
        var stop = scanForGanCubes(manager, () => { }, (e) => errors.push(e));
        fail(new Error('Bluetooth is off'));
        expect(errors).toHaveLength(1);
        stop();
        stop();
        expect(stopped()).toBe(1);
    });

});

describe('the native transport', () => {

    function fakeDevice() {
        var monitor: ((error: unknown, c: BlePlxCharacteristic | null) => void) | null = null;
        var disconnect: ((error: unknown, d: BlePlxDevice | null) => void) | null = null;
        var writes: Array<{ value: string; withResponse: boolean }> = [];
        var removed = 0;
        var monitorSubscribeCount = 0;
        var connected = true;
        var device = {
            id: 'AB:12:34:56:78:9A',
            name: 'GANicTEST',
            connect: async () => device,
            discoverAllServicesAndCharacteristics: async () => device,
            services: async () => [] as Array<BlePlxService>,
            isConnected: async () => connected,
            cancelConnection: async () => { connected = false; return device; },
            onDisconnected: (cb: (error: unknown, d: BlePlxDevice | null) => void) => {
                disconnect = cb;
                return { remove: () => { removed++; } };
            },
            writeCharacteristicWithResponseForService: async (_s: string, _c: string, value: string) => {
                writes.push({ value, withResponse: true });
                return {} as BlePlxCharacteristic;
            },
            writeCharacteristicWithoutResponseForService: async (_s: string, _c: string, value: string) => {
                writes.push({ value, withResponse: false });
                return {} as BlePlxCharacteristic;
            },
            monitorCharacteristicForService: (_s: string, _c: string, cb: (error: unknown, c: BlePlxCharacteristic | null) => void) => {
                monitor = cb;
                monitorSubscribeCount++;
                return { remove: () => { removed++; } };
            }
        } as unknown as BlePlxDevice;
        return {
            device,
            writes,
            removedCount: () => removed,
            monitorSubscribeCount: () => monitorSubscribeCount,
            isConnected: () => connected,
            setConnected: (value: boolean) => { connected = value; },
            notify: (bytes: Uint8Array) => monitor?.(null, { value: toBase64(bytes) } as BlePlxCharacteristic),
            notifyError: (e: unknown) => monitor?.(e, null),
            dropLink: (e: unknown = new Error('lost')) => disconnect?.(e, null)
        };
    }

    const writable = { uuid: 'cmd-uuid', isWritableWithResponse: true, isWritableWithoutResponse: false } as BlePlxCharacteristic;
    const writableWithoutResponse = { uuid: 'cmd-uuid', isWritableWithResponse: false, isWritableWithoutResponse: true } as BlePlxCharacteristic;

    it('decodes notifications into bytes', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var received: Array<Array<number>> = [];
        transport.subscribe((data) => { received.push(Array.from(data)); });
        fake.notify(new Uint8Array([0x02, 0xFF, 0x00, 0x7F]));
        expect(received).toEqual([[0x02, 0xFF, 0x00, 0x7F]]);
    });

    it('encodes writes and honours the characteristic write mode', async () => {
        var withResponse = fakeDevice();
        var t1 = await NativeBleTransport.create(withResponse.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        await t1.write(new Uint8Array([0x09, 0x00]));
        expect(withResponse.writes[0]).toEqual({ value: toBase64(new Uint8Array([0x09, 0x00])), withResponse: true });

        var without = fakeDevice();
        var t2 = await NativeBleTransport.create(without.device, 'AB:12:34:56:78:9A', 'svc', writableWithoutResponse, 'state-uuid');
        await t2.write(new Uint8Array([0x09, 0x00]));
        expect(without.writes[0].withResponse).toBe(false);
    });

    it('takes the device name and the MAC it was given', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        expect(transport.deviceName).toBe('GANicTEST');
        expect(transport.deviceMAC).toBe('AB:12:34:56:78:9A');
    });

    it('does not treat a monitor error as a disconnect while the OS link is still up', async () => {
        // ble-plx can surface a transient error on the monitor subscription
        // while device.isConnected() still says yes — the whole point of
        // M1-4d: a non-fatal monitor error must not tear a live session down.
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var dropped = 0;
        transport.onDisconnect(() => { dropped++; });
        fake.setConnected(true);
        await fake.notifyError(new Error('transient'));
        expect(dropped).toBe(0);
    });

    it('replaces the monitor subscription after a non-fatal error, so notifications keep arriving', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var received: Array<Array<number>> = [];
        transport.subscribe((data) => { received.push(Array.from(data)); });
        fake.setConnected(true);
        await fake.notifyError(new Error('transient'));
        expect(fake.monitorSubscribeCount()).toBe(2);
        fake.notify(new Uint8Array([0x02, 0x01]));
        expect(received).toEqual([[0x02, 0x01]]);
    });

    it('treats a monitor error as a disconnect once the OS link is genuinely gone', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var reasons: Array<unknown> = [];
        transport.onDisconnect((reason) => { reasons.push(reason); });
        fake.setConnected(false);
        await fake.notifyError(new Error('device disconnected'));
        expect(reasons).toEqual([{ source: 'monitor', code: undefined, message: 'device disconnected' }]);
    });

    it('carries the onDisconnected error onto the disconnect reason', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var reasons: Array<unknown> = [];
        transport.onDisconnect((reason) => { reasons.push(reason); });
        fake.dropLink({ errorCode: 201, message: 'Device disconnected' });
        expect(reasons).toEqual([{ source: 'onDisconnected', code: 201, message: 'Device disconnected' }]);
    });

    it('reports a dropped link exactly once', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var dropped = 0;
        transport.onDisconnect(() => { dropped++; });
        fake.dropLink();
        fake.setConnected(false);
        await fake.notifyError(new Error('and again'));
        expect(dropped).toBe(1);
    });

    it('removes its subscriptions and closes the connection on disconnect', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        await transport.disconnect();
        expect(fake.removedCount()).toBe(2);
        expect(fake.isConnected()).toBe(false);
    });

    it('is safe to disconnect twice', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        await transport.disconnect();
        await expect(transport.disconnect()).resolves.toBeUndefined();
    });

    it('stops delivering notifications after the link drops', async () => {
        var fake = fakeDevice();
        var transport = await NativeBleTransport.create(fake.device, 'AB:12:34:56:78:9A', 'svc', writable, 'state-uuid');
        var received: Array<Array<number>> = [];
        transport.subscribe((data) => { received.push(Array.from(data)); });
        fake.dropLink();
        fake.notify(new Uint8Array([0x02, 0x01]));
        expect(received).toHaveLength(0);
    });

});
