
import { createGanCubeConnection } from '../gan-cube-connection';
import { createDriver, createEncrypter, generationForService, GAN_SERVICES } from '../gan-cube-generations';
import { GanCubeConnection } from '../gan-cube-protocol';
import { BlePlxDevice, BlePlxManager } from './ble-plx';
import { NativeBleTransport } from './native-transport';
import { NativeMacAddressProvider, macFromManufacturerData, resolveCubeMAC } from './mac-address';

/**
 * Connecting to a GAN cube from React Native.
 *
 * The entry point deliberately does *not* wrap scanning in a "just connect"
 * helper. On iOS the MAC address is only present on a scan result (see
 * `mac-address.ts`), so the scan and the connection cannot be separated in time
 * without losing the one piece of data that makes the connection possible. The
 * API therefore hands the app scan results that already carry a resolved MAC,
 * and connects from one of those.
 */

/** A GAN cube seen in a scan, with everything needed to connect to it. */
type GanCubeScanResult = {
    /** The underlying ble-plx device. */
    device: BlePlxDevice;
    /** Advertised name, e.g. `GANicC1a2b3`. */
    name: string;
    /** Platform device identifier — the MAC on Android, a random UUID on iOS. */
    id: string;
    /**
     * The cube's MAC address, resolved at scan time.
     *
     * Null means the advertisement did not carry one and the id was not a MAC —
     * on iOS this is the difference between a cube that can be connected to and
     * one that cannot, so a UI should say so rather than offering the row and
     * failing later.
     */
    mac: string | null;
};

/** Names GAN cubes advertise under. Mirrors the Web Bluetooth filters. */
const GAN_NAME_PREFIXES = ['GAN', 'MG', 'AiCube'];

function isGanCubeName(name: string | null | undefined): boolean {
    return !!name && GAN_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Scan for GAN cubes.
 *
 * Filtering is by **name** rather than by service UUID, which looks like the
 * lazy choice and is not: a GAN cube does not advertise its primary service, so
 * passing `GAN_SERVICES` to `startDeviceScan` returns nothing at all. The
 * generation is discovered after connecting, from the services the cube
 * actually exposes.
 *
 * @returns a function that stops the scan. Call it — a scan left running is a
 *          battery drain the user cannot see and cannot stop.
 */
function scanForGanCubes(
    manager: BlePlxManager,
    onResult: (result: GanCubeScanResult) => void,
    onError?: (error: unknown) => void
): () => void {
    var seen = new Set<string>();
    manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) {
            onError?.(error);
            return;
        }
        if (!device) return;
        var name = device.name || device.localName || '';
        if (!isGanCubeName(name)) return;
        if (seen.has(device.id)) return;
        seen.add(device.id);
        onResult({
            device,
            name,
            id: device.id,
            // Resolved here, while the advertisement is in hand. This is the
            // only moment iOS will ever offer it.
            mac: /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(device.id)
                ? device.id.replace(/-/g, ':').toUpperCase()
                : macFromManufacturerData(device.manufacturerData)
        });
    });
    var stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        manager.stopDeviceScan();
    };
}

/**
 * Connect to a cube found by `scanForGanCubes`.
 *
 * Discovers which protocol generation the cube speaks from its primary services,
 * builds the matching encrypter and driver, and returns the same
 * `GanCubeConnection` the web path returns — from there nothing is
 * platform-specific.
 *
 * @param result     a scan result, whose `mac` should already be resolved
 * @param provider   last-resort MAC supplier, for the iOS case where the
 *                   advertisement carried nothing
 */
async function connectGanCubeNative(
    result: GanCubeScanResult,
    provider?: NativeMacAddressProvider
): Promise<GanCubeConnection> {

    var mac = result.mac || await resolveCubeMAC(result.device, provider);

    var device = await result.device.connect();
    await device.discoverAllServicesAndCharacteristics();
    var services = await device.services();

    for (let service of services) {
        let profile = generationForService(service.uuid);
        if (!profile) continue;
        let characteristics = await service.characteristics();
        let command = characteristics.find((c) => c.uuid.toLowerCase() == profile.commandCharacteristic);
        let state = characteristics.find((c) => c.uuid.toLowerCase() == profile.stateCharacteristic);
        if (!command || !state) continue;
        let transport = await NativeBleTransport.create(device, mac, service.uuid, command, state.uuid);
        return createGanCubeConnection(
            transport,
            createEncrypter(profile.generation, mac, result.name),
            createDriver(profile.generation)
        );
    }

    // Leaving a useless connection open would hold the cube against the next
    // attempt, which on iOS can take a power cycle to clear.
    await device.cancelConnection().catch(() => { });
    throw new Error("Can't find target BLE services - wrong or unsupported cube device model");
}

export type {
    GanCubeScanResult,
    NativeMacAddressProvider,
    BlePlxDevice,
    BlePlxManager
};

export {
    GAN_SERVICES,
    GAN_NAME_PREFIXES,
    isGanCubeName,
    scanForGanCubes,
    connectGanCubeNative,
    macFromManufacturerData,
    resolveCubeMAC,
    NativeBleTransport
};
